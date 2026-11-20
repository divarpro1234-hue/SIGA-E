import { createHash, randomUUID } from "node:crypto";
import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { Prisma, type PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaPublicAlertService } from "../../src/modules/public/public-alert-service.js";
import { JoseAlertSigner } from "../../src/modules/signing/jose-alert-signer.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";
import { createPrismaClient } from "../../src/infrastructure/database/prisma-client.js";
import {
  readApprovedTestAttestation,
  type TestAttestation,
} from "../../scripts/m4-postgres-admin-preflight.js";
import {
  isLocalSoloLabRequested,
  readLocalSoloLabAuthorization,
  readLocalSoloLabPreflightReport,
  m4LocalSoloRequiredMigrations,
} from "../../scripts/m4-local-solo-authorization.js";

const acknowledgement = "I_ACKNOWLEDGE_M4_DISPOSABLE_POSTGRES";
const privilegesOnly = process.env["SIGAE_M4_PRIVILEGES_ONLY"] === "1";
const requiredMigrations = m4LocalSoloRequiredMigrations;
const allowedFixtureTables = [
  "users",
  "public_keys",
  "alerts",
  "anchor_deployments",
  "anchor_jobs",
] as const;

interface LabTarget {
  readonly url: string;
  readonly databaseName: string;
  readonly roleName: string;
  readonly port: number;
  readonly attestation: Pick<
    TestAttestation,
    "databaseName" | "adminRoleName" | "runnerRoleName" | "host" | "port"
  >;
}

interface LabIdentity {
  readonly databaseName: string;
  readonly roleName: string;
  readonly serverAddress: string | null;
  readonly serverPort: number | null;
  readonly listenAddresses: string;
  readonly timeZone: string;
  readonly serverVersionNum: number;
  readonly publicOnlySearchPath: boolean;
  readonly isSuperuser: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canReplicate: boolean;
  readonly canBypassRls: boolean;
  readonly noRoleMemberships: boolean;
  readonly noAdminRoleMembership: boolean;
  readonly noDatabaseCreatePrivilege: boolean;
  readonly noDatabaseTemporaryPrivilege: boolean;
  readonly noOtherDatabaseConnectPrivilege: boolean;
  readonly noOtherDatabaseTemporaryPrivilege: boolean;
  readonly noDatabaseOwnership: boolean;
  readonly hasPublicSchemaUsage: boolean;
  readonly noPublicCreatePrivilege: boolean;
  readonly noOtherSchemaPrivileges: boolean;
  readonly noSchemaOwnership: boolean;
  readonly fixtureRelationsAreTables: boolean;
  readonly noOtherRelationPrivileges: boolean;
  readonly noColumnPrivileges: boolean;
  readonly noSequencePrivileges: boolean;
  readonly noRelationOwnership: boolean;
  readonly noGrantOptions: boolean;
  readonly hasFixturePrivileges: boolean;
}

interface MigrationRow {
  readonly migrationName: string;
  readonly finished: boolean;
  readonly notRolledBack: boolean;
}

interface FixtureOptions {
  readonly lifecycleState?: "PUBLISHED" | "SIGNED_PENDING_ANCHOR";
  readonly anchorStatus?: "CONFIRMED" | "PENDING";
  readonly jobState?: "CONFIRMED" | "PENDING";
  readonly jobJwsHashMismatch?: boolean;
  readonly jobMessageKeyMismatch?: boolean;
  readonly jobTxHash?: string | null;
  readonly confirmedLedger?: bigint | null;
  readonly additionalJob?: boolean;
  readonly publishedAt?: Date;
}

interface AlertFixture {
  readonly id: string;
  readonly identifier: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
}

function readLabTarget(environment: NodeJS.ProcessEnv): LabTarget {
  const localSoloLab = isLocalSoloLabRequested(environment);
  if (!localSoloLab &&
      environment["SIGAE_M4_PG_TEST_DISPOSABLE_ACK"] !== acknowledgement) {
    throw new Error("M4_PG_PREFLIGHT_ACK_REQUIRED");
  }
  let attestation: LabTarget["attestation"];
  if (localSoloLab) {
    const authorization = readLocalSoloLabAuthorization(
      environment,
      "RUN_POSTGRES_HARNESS",
    );
    readLocalSoloLabPreflightReport(environment, authorization);
    attestation = authorization;
  } else {
    attestation = readApprovedTestAttestation(environment);
  }
  const rawUrl = environment["SIGAE_M4_PG_TEST_URL"];
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    throw new Error("M4_PG_TEST_URL_REQUIRED");
  }
  if (rawUrl.includes("?") || rawUrl.includes("#")) {
    throw new Error("M4_PG_TEST_DESTINATION_REJECTED");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("M4_PG_TEST_URL_INVALID");
  }

  let databaseName: string;
  let roleName: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
    roleName = decodeURIComponent(url.username);
  } catch {
    throw new Error("M4_PG_TEST_URL_INVALID");
  }

  const allowedHost = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  const explicitLoopbackHost = url.hostname === "127.0.0.1"
    ? "127.0.0.1"
    : url.hostname === "[::1]" ? "::1" : undefined;
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      !allowedHost || !url.port || url.search !== "" || url.hash !== "" ||
      !url.username || !url.password || url.username !== roleName ||
      !/^sigae_m4_test_[a-z0-9_]{1,48}$/u.test(databaseName) ||
      !/^sigae_m4_test_[a-z0-9_]{1,48}$/u.test(roleName) ||
      databaseName !== attestation.databaseName ||
      roleName !== attestation.runnerRoleName ||
      Number(url.port) !== attestation.port ||
      (explicitLoopbackHost !== undefined && explicitLoopbackHost !== attestation.host)) {
    throw new Error("M4_PG_TEST_DESTINATION_REJECTED");
  }

  return {
    url: rawUrl,
    databaseName,
    roleName,
    port: Number(url.port),
    attestation,
  };
}

const target = readLabTarget(process.env);

let database: PrismaClient | undefined;
let service: PrismaPublicAlertService | undefined;
let signer: JoseAlertSigner | undefined;
let testUserId: string | undefined;
let testKeyId: string | undefined;
let primaryDeploymentId: string | undefined;
let nextIdentifier = 0;
const transientAlertIds: string[] = [];
const transientJobIds: string[] = [];
const transientDeploymentIds: string[] = [];
let cleanupFailure = false;
let cleanupFailureError: unknown;

function assertFixtureCreationAllowed(): void {
  if (cleanupFailure) {
    throw new Error("M4_PG_CLEANUP_FAILURE_BLOCKS_FIXTURES", {
      cause: cleanupFailureError,
    });
  }
}

function requireDatabase(): PrismaClient {
  if (!database) throw new Error("M4_PG_TEST_CLIENT_NOT_READY");
  return database;
}

function requireService(): PrismaPublicAlertService {
  if (!service) throw new Error("M4_PG_TEST_SERVICE_NOT_READY");
  return service;
}

function requireTestKeyId(): string {
  if (!testKeyId) throw new Error("M4_PG_TEST_KEY_NOT_READY");
  return testKeyId;
}

function requireTestUserId(): string {
  if (!testUserId) throw new Error("M4_PG_TEST_USER_NOT_READY");
  return testUserId;
}

function requirePrimaryDeploymentId(): string {
  if (!primaryDeploymentId) throw new Error("M4_PG_TEST_DEPLOYMENT_NOT_READY");
  return primaryDeploymentId;
}

async function verifyLabIdentity(client: PrismaClient): Promise<void> {
  let rows: LabIdentity[];
  try {
    rows = await client.$queryRaw<LabIdentity[]>`
      SELECT
        current_database() AS "databaseName",
        current_user AS "roleName",
        host(inet_server_addr()) AS "serverAddress",
        inet_server_port() AS "serverPort",
        current_setting('listen_addresses') AS "listenAddresses",
        current_setting('TimeZone') AS "timeZone",
        current_setting('server_version_num')::integer AS "serverVersionNum",
        current_schemas(false) = ARRAY['public']::name[] AS "publicOnlySearchPath",
        pg_role.rolsuper AS "isSuperuser",
        pg_role.rolcreatedb AS "canCreateDatabase",
        pg_role.rolcreaterole AS "canCreateRole",
        pg_role.rolreplication AS "canReplicate",
        pg_role.rolbypassrls AS "canBypassRls",
        NOT EXISTS (
          SELECT 1
          FROM pg_database AS db
          WHERE has_database_privilege(current_user, db.oid, 'CREATE')
        )
          AS "noDatabaseCreatePrivilege",
        NOT EXISTS (
          SELECT 1
          FROM pg_database AS db
          WHERE db.datname <> current_database()
            AND has_database_privilege(current_user, db.oid, 'CONNECT')
        ) AS "noOtherDatabaseConnectPrivilege",
        NOT has_database_privilege(current_user, current_database(), 'TEMPORARY')
          AS "noDatabaseTemporaryPrivilege",
        NOT EXISTS (
          SELECT 1
          FROM pg_database AS db
          WHERE db.datname <> current_database()
            AND has_database_privilege(current_user, db.oid, 'TEMPORARY')
        ) AS "noOtherDatabaseTemporaryPrivilege",
        NOT EXISTS (
          SELECT 1
          FROM pg_database AS db
          WHERE db.datdba = to_regrole(current_user)::oid
        ) AS "noDatabaseOwnership",
        has_schema_privilege(current_user, 'public', 'USAGE')
          AS "hasPublicSchemaUsage",
        NOT has_schema_privilege(current_user, 'public', 'CREATE')
          AS "noPublicCreatePrivilege",
        NOT EXISTS (
          SELECT 1
          FROM pg_roles AS inherited_role
          WHERE inherited_role.rolname <> current_user
            AND pg_has_role(current_user, inherited_role.rolname, 'MEMBER')
        ) AS "noRoleMemberships",
        NOT pg_has_role(
          current_user,
          ${target.attestation.adminRoleName},
          'MEMBER'
        ) AS "noAdminRoleMembership",
        NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS nsp
          WHERE nsp.nspname NOT IN (
            'pg_catalog',
            'information_schema',
            'public'
          )
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND (
              has_schema_privilege(current_user, nsp.oid, 'USAGE') OR
              has_schema_privilege(current_user, nsp.oid, 'CREATE')
            )
        ) AS "noOtherSchemaPrivileges",
        NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS nsp
          WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND nsp.nspowner = to_regrole(current_user)::oid
        ) AS "noSchemaOwnership",
        NOT EXISTS (
          SELECT 1
          FROM unnest(ARRAY[
            'users',
            'public_keys',
            'alerts',
            'anchor_deployments',
            'anchor_jobs',
            '_prisma_migrations'
          ]::name[]) AS expected(relation_name)
          LEFT JOIN pg_class AS relation
            ON relation.relnamespace = 'public'::regnamespace
            AND relation.relname = expected.relation_name
          WHERE relation.oid IS NULL OR relation.relkind NOT IN ('r', 'p')
        ) AS "fixtureRelationsAreTables",
        NOT EXISTS (
          SELECT 1
          FROM pg_class AS relation
          INNER JOIN pg_namespace AS nsp ON nsp.oid = relation.relnamespace
          CROSS JOIN LATERAL unnest(ARRAY[
            'SELECT',
            'INSERT',
            'UPDATE',
            'DELETE',
            'TRUNCATE',
            'REFERENCES',
            'TRIGGER',
            'MAINTAIN'
          ]::text[]) AS privilege(privilege_name)
          WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              has_table_privilege(
                current_user,
                relation.oid,
                privilege.privilege_name
              ) OR (
                privilege.privilege_name = ANY (ARRAY[
                  'SELECT',
                  'INSERT',
                  'UPDATE',
                  'REFERENCES'
                ]::text[])
                AND has_any_column_privilege(
                  current_user,
                  relation.oid,
                  privilege.privilege_name
                )
              )
            )
            AND NOT (
              nsp.nspname = 'public'
              AND (
                (
                  relation.relname = ANY (
                    ${Prisma.sql`ARRAY[${Prisma.join(allowedFixtureTables)}]::name[]`}
                  )
                  AND privilege.privilege_name = ANY (ARRAY[
                    'SELECT',
                    'INSERT',
                    'DELETE'
                  ]::text[])
                )
                OR (
                  relation.relname = '_prisma_migrations'
                  AND privilege.privilege_name = 'SELECT'
                )
              )
            )
        ) AS "noOtherRelationPrivileges",
        NOT EXISTS (
          SELECT 1
          FROM pg_attribute AS column_acl
          INNER JOIN pg_class AS relation ON relation.oid = column_acl.attrelid
          INNER JOIN pg_namespace AS nsp ON nsp.oid = relation.relnamespace
          CROSS JOIN LATERAL aclexplode(
            column_acl.attacl
          ) AS acl
          WHERE column_acl.attnum > 0
            AND NOT column_acl.attisdropped
            AND nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND (
              acl.grantee = 0 OR
              acl.grantee = to_regrole(current_user)::oid
            )
        ) AS "noColumnPrivileges",
        NOT EXISTS (
          SELECT 1
          FROM pg_class AS seq
          INNER JOIN pg_namespace AS nsp ON nsp.oid = seq.relnamespace
          WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND seq.relkind = 'S'
            AND (
              has_sequence_privilege(current_user, seq.oid, 'USAGE') OR
              has_sequence_privilege(current_user, seq.oid, 'SELECT') OR
              has_sequence_privilege(current_user, seq.oid, 'UPDATE')
            )
        ) AS "noSequencePrivileges",
        NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS nsp
          INNER JOIN pg_class AS relation ON relation.relnamespace = nsp.oid
          WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND relation.relowner = to_regrole(current_user)::oid
        ) AS "noRelationOwnership",
        NOT EXISTS (
          SELECT 1
          FROM pg_database AS db
          CROSS JOIN LATERAL aclexplode(
            db.datacl
          ) AS acl
          WHERE acl.is_grantable
            AND (
              acl.grantee = 0 OR
              acl.grantee = to_regrole(current_user)::oid
            )
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_namespace AS nsp
          CROSS JOIN LATERAL aclexplode(
            nsp.nspacl
          ) AS acl
          WHERE acl.is_grantable
            AND (
              acl.grantee = 0 OR
              acl.grantee = to_regrole(current_user)::oid
            )
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_class AS relation
          INNER JOIN pg_namespace AS nsp ON nsp.oid = relation.relnamespace
          CROSS JOIN LATERAL aclexplode(
            relation.relacl
          ) AS acl
          WHERE nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
            AND acl.is_grantable
            AND (
              acl.grantee = 0 OR
              acl.grantee = to_regrole(current_user)::oid
            )
        ) AND NOT EXISTS (
          SELECT 1
          FROM pg_attribute AS column_acl
          INNER JOIN pg_class AS relation ON relation.oid = column_acl.attrelid
          INNER JOIN pg_namespace AS nsp ON nsp.oid = relation.relnamespace
          CROSS JOIN LATERAL aclexplode(
            column_acl.attacl
          ) AS acl
          WHERE column_acl.attnum > 0
            AND NOT column_acl.attisdropped
            AND nsp.nspname NOT IN ('pg_catalog', 'information_schema')
            AND nsp.nspname NOT LIKE 'pg_toast%'
            AND nsp.nspname NOT LIKE 'pg_temp_%'
            AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
            AND acl.is_grantable
            AND (
              acl.grantee = 0 OR
              acl.grantee = to_regrole(current_user)::oid
            )
        ) AS "noGrantOptions",
        (
          has_table_privilege(current_user, 'public.users', 'SELECT') AND
          has_table_privilege(current_user, 'public.users', 'INSERT') AND
          has_table_privilege(current_user, 'public.users', 'DELETE') AND
          has_table_privilege(current_user, 'public.public_keys', 'SELECT') AND
          has_table_privilege(current_user, 'public.public_keys', 'INSERT') AND
          has_table_privilege(current_user, 'public.public_keys', 'DELETE') AND
          has_table_privilege(current_user, 'public.alerts', 'SELECT') AND
          has_table_privilege(current_user, 'public.alerts', 'INSERT') AND
          has_table_privilege(current_user, 'public.alerts', 'DELETE') AND
          has_table_privilege(current_user, 'public.anchor_deployments', 'SELECT') AND
          has_table_privilege(current_user, 'public.anchor_deployments', 'INSERT') AND
          has_table_privilege(current_user, 'public.anchor_deployments', 'DELETE') AND
          has_table_privilege(current_user, 'public.anchor_jobs', 'SELECT') AND
          has_table_privilege(current_user, 'public.anchor_jobs', 'INSERT') AND
          has_table_privilege(current_user, 'public.anchor_jobs', 'DELETE') AND
          has_table_privilege(current_user, 'public._prisma_migrations', 'SELECT')
        ) AS "hasFixturePrivileges"
      FROM pg_roles AS pg_role
      WHERE pg_role.rolname = current_user
    `;
  } catch (error) {
    throw new Error("M4_PG_PRIVILEGES_NO_VERIFICADO", {
      cause: error,
    });
  }

  const identity = rows[0];
  if (!identity || rows.length !== 1) {
    throw new Error("M4_PG_PRIVILEGES_NO_VERIFICADO");
  }
  const privilegeResults: readonly unknown[] = [
    identity.isSuperuser,
    identity.canCreateDatabase,
    identity.canCreateRole,
    identity.canReplicate,
    identity.canBypassRls,
    identity.noRoleMemberships,
    identity.noAdminRoleMembership,
    identity.noDatabaseCreatePrivilege,
    identity.noDatabaseTemporaryPrivilege,
    identity.noOtherDatabaseConnectPrivilege,
    identity.noOtherDatabaseTemporaryPrivilege,
    identity.noDatabaseOwnership,
    identity.hasPublicSchemaUsage,
    identity.noPublicCreatePrivilege,
    identity.noOtherSchemaPrivileges,
    identity.noSchemaOwnership,
    identity.fixtureRelationsAreTables,
    identity.noOtherRelationPrivileges,
    identity.noColumnPrivileges,
    identity.noSequencePrivileges,
    identity.noRelationOwnership,
    identity.noGrantOptions,
    identity.hasFixturePrivileges,
  ];
  if (privilegeResults.some((value) => typeof value !== "boolean")) {
    throw new Error("M4_PG_PRIVILEGES_NO_VERIFICADO");
  }
  const loopback = identity?.serverAddress === "127.0.0.1" ||
    identity?.serverAddress === "::1";
  if (identity.databaseName !== target.databaseName ||
      identity.roleName !== target.roleName ||
      identity.roleName === target.attestation.adminRoleName ||
      !loopback || identity.serverAddress !== target.attestation.host ||
      identity.listenAddresses !== target.attestation.host ||
      identity.serverPort !== target.port ||
      identity.timeZone !== "UTC" ||
      identity.serverVersionNum < 170000 || identity.serverVersionNum >= 180000 ||
      !identity.publicOnlySearchPath ||
      identity.isSuperuser || identity.canCreateDatabase || identity.canCreateRole ||
      identity.canReplicate || identity.canBypassRls ||
      !identity.noRoleMemberships || !identity.noAdminRoleMembership ||
      !identity.noDatabaseCreatePrivilege ||
      !identity.noDatabaseTemporaryPrivilege ||
      !identity.noOtherDatabaseConnectPrivilege ||
      !identity.noOtherDatabaseTemporaryPrivilege ||
      !identity.noDatabaseOwnership ||
      !identity.hasPublicSchemaUsage || !identity.noPublicCreatePrivilege ||
      !identity.noOtherSchemaPrivileges || !identity.noSchemaOwnership ||
      !identity.fixtureRelationsAreTables || !identity.noOtherRelationPrivileges ||
      !identity.noColumnPrivileges ||
      !identity.noSequencePrivileges || !identity.noRelationOwnership ||
      !identity.noGrantOptions ||
      !identity.hasFixturePrivileges) {
    throw new Error("M4_PG_IDENTITY_REJECTED");
  }
}

async function verifyMigrationsAndEmptyFixtureTables(client: PrismaClient): Promise<void> {
  let migrations: MigrationRow[];
  try {
    migrations = await client.$queryRaw<MigrationRow[]>`
      SELECT
        migration_name AS "migrationName",
        finished_at IS NOT NULL AS finished,
        rolled_back_at IS NULL AS "notRolledBack"
      FROM public."_prisma_migrations"
      ORDER BY migration_name
    `;
  } catch (error) {
    throw new Error("M4_PG_MIGRATION_HISTORY_UNAVAILABLE", { cause: error });
  }

  const actualNames = new Set(migrations.map((migration) => migration.migrationName));
  if (migrations.length !== requiredMigrations.length ||
      requiredMigrations.some((name) => !actualNames.has(name)) ||
      migrations.some((migration) => !migration.finished || !migration.notRolledBack)) {
    throw new Error("M4_PG_MIGRATION_HISTORY_REJECTED");
  }

  let emptyRows: Array<{ readonly empty: boolean }>;
  try {
    emptyRows = await client.$queryRaw<Array<{ readonly empty: boolean }>>`
      SELECT
        (SELECT COUNT(*) = 0 FROM public.users) AND
        (SELECT COUNT(*) = 0 FROM public.alerts) AND
        (SELECT COUNT(*) = 0 FROM public.public_keys) AND
        (SELECT COUNT(*) = 0 FROM public.anchor_deployments) AND
        (SELECT COUNT(*) = 0 FROM public.anchor_jobs) AS empty
    `;
  } catch (error) {
    throw new Error("M4_PG_EMPTY_DATABASE_CHECK_FAILED", { cause: error });
  }
  if (emptyRows.length !== 1 || emptyRows[0]?.empty !== true) {
    throw new Error("M4_PG_DATABASE_NOT_EMPTY");
  }
}

async function createDeployment(
  state: "ACTIVE" | "RETIRED",
  generation: number,
  trackForCleanup: boolean,
): Promise<string> {
  assertFixtureCreationAllowed();
  const id = randomUUID();
  if (trackForCleanup) transientDeploymentIds.push(id);
  else primaryDeploymentId = id;
  await requireDatabase().anchorDeployment.create({
    data: {
      id,
      network: "TESTNET",
      networkPassphrase: "SIMULACRO-M4-NO-RED",
      contractId: `SIMULACRO-M4-${randomUUID()}`,
      wasmHash: createHash("sha256").update(randomUUID()).digest("hex"),
      adminPublicAddress: `SIMULACRO-${randomUUID()}`,
      generation,
      state,
      deployedAt: new Date(),
      trustedConfigVersion: `SIMULACRO-M4-${randomUUID()}`,
    },
  });
  return id;
}

async function createAlertFixture(options: FixtureOptions = {}): Promise<AlertFixture> {
  assertFixtureCreationAllowed();
  const client = requireDatabase();
  const id = randomUUID();
  const jobId = randomUUID();
  const identifier = `SIGAE-M4-PG-${randomUUID()}`;
  const sender = "urn:siga-e:simulacro";
  const sent = new Date(Date.now() + nextIdentifier++).toISOString();
  const publishedAt = options.publishedAt ?? new Date();
  const payload = {
    sender,
    identifier,
    sent,
    status: "Exercise",
    scope: "Public",
    msgType: "Alert",
    info: {
      scenario: "SISMO",
      event: "Simulacro de sismo",
      severity: "Severe",
      urgency: "Immediate",
      certainty: "Likely",
      headline: "SIMULACRO: alerta ficticia",
      description: "Dato sintético de prueba; no constituye una alerta real.",
      expires: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      areaDesc: "Área ficticia M4",
    },
  };
  const frozenPayload = new TextEncoder().encode(JSON.stringify(payload));
  const payloadSha256 = new Uint8Array(createHash("sha256").update(frozenPayload).digest());
  const currentSigner = signer;
  if (!currentSigner) throw new Error("M4_PG_SIGNER_NOT_READY");
  const jwsCompact = await currentSigner.sign(frozenPayload);
  const jwsHash = calculateJwsHash(jwsCompact);
  const messageKey = calculateMessageKey({ sender, identifier, sent });

  transientAlertIds.push(id);
  await client.alert.create({
    data: {
      id,
      sender,
      identifier,
      sentText: sent,
      kind: "Alert",
      severity: "Severe",
      lifecycleState: options.lifecycleState ?? "PUBLISHED",
      anchorStatus: options.anchorStatus ?? "CONFIRMED",
      frozenPayload,
      payloadSha256,
      approvedPayloadSha256: new Uint8Array(payloadSha256),
      jwsCompact,
      kid: requireTestKeyId(),
      messageKey: new Uint8Array(messageKey),
      jwsHash: new Uint8Array(jwsHash),
      authorId: requireTestUserId(),
      publishedAt,
    },
  });

  const primaryJobMessageKey = options.jobMessageKeyMismatch
    ? alterFirstByte(messageKey)
    : messageKey;
  const primaryJobJwsHash = options.jobJwsHashMismatch
    ? alterFirstByte(jwsHash)
    : jwsHash;
  const defaultJobTxHash = (options.jobState ?? "CONFIRMED") === "CONFIRMED"
    ? `SIMULACRO-${randomUUID()}`
    : null;
  transientJobIds.push(jobId);
  await client.anchorJob.create({
    data: {
      id: jobId,
      alertId: id,
      deploymentId: requirePrimaryDeploymentId(),
      messageKey: new Uint8Array(primaryJobMessageKey),
      jwsHash: new Uint8Array(primaryJobJwsHash),
      state: options.jobState ?? "CONFIRMED",
      txHash: options.jobTxHash === undefined ? defaultJobTxHash : options.jobTxHash,
      confirmedLedger: options.confirmedLedger === undefined
        ? (options.jobState ?? "CONFIRMED") === "CONFIRMED" ? 42n : null
        : options.confirmedLedger,
    },
  });

  if (options.additionalJob) {
    const secondDeploymentId = await createDeployment("RETIRED", 2, true);
    const secondJobId = randomUUID();
    transientJobIds.push(secondJobId);
    await client.anchorJob.create({
      data: {
        id: secondJobId,
        alertId: id,
        deploymentId: secondDeploymentId,
        messageKey: new Uint8Array(messageKey),
        jwsHash: new Uint8Array(jwsHash),
        state: "CONFIRMED",
        txHash: `SIMULACRO-${randomUUID()}`,
        confirmedLedger: 43n,
      },
    });
  }

  return { id, identifier, messageKey, jwsHash };
}

function alterFirstByte(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const altered = new Uint8Array(bytes);
  altered[0] = altered[0]! ^ 0xff;
  return altered;
}

async function expectExcluded(fixture: AlertFixture): Promise<void> {
  const result = await requireService().list(1, 20);
  expect(result.items.map((item) => item.id)).not.toContain(fixture.id);
  expect(result.total).toBe(0);
}

const confirmedLedgerConstraint = "anchor_jobs_confirmed_ledger_positive";

function hasConfirmedLedgerConstraintEvidence(error: unknown): boolean {
  const pending: Array<{ readonly value: unknown; readonly key: string; readonly depth: number }> = [
    { value: error, key: "", depth: 0 },
  ];
  const visited = new Set<object>();
  const sqlStateInText = /(?:SQLSTATE\s*[:=]?\s*|(?:PostgreSQL|Postgres)\s+code\s*[:=]?\s*)23514\b/iu;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > 6) continue;

    if (typeof current.value === "string") {
      if (current.value.includes(confirmedLedgerConstraint) ||
          sqlStateInText.test(current.value)) {
        return true;
      }
      if (current.key.toLowerCase().replace(/[_-]/gu, "") === "sqlstate" &&
          current.value === "23514") {
        return true;
      }
      continue;
    }

    if (typeof current.value !== "object" || current.value === null ||
        visited.has(current.value)) {
      continue;
    }
    visited.add(current.value);

    if (current.value instanceof Error) {
      pending.push(
        { value: current.value.message, key: "message", depth: current.depth + 1 },
        { value: current.value.cause, key: "cause", depth: current.depth + 1 },
      );
    }

    for (const key of Object.getOwnPropertyNames(current.value)) {
      const value: unknown = Reflect.get(current.value, key);
      const normalizedKey = key.toLowerCase().replace(/[_-]/gu, "");
      if ((normalizedKey === "constraint" || normalizedKey === "constraintname") &&
          value === confirmedLedgerConstraint) {
        return true;
      }
      if ((normalizedKey === "sqlstate" ||
          normalizedKey === "postgrescode" ||
          normalizedKey === "databasecode" ||
          normalizedKey === "originalcode" ||
          (normalizedKey === "code" && current.depth > 0)) &&
          value === "23514") {
        return true;
      }
      pending.push({ value, key, depth: current.depth + 1 });
    }
  }

  return false;
}

async function expectConfirmedLedgerCheckViolation(ledger: bigint): Promise<void> {
  let actualError: unknown;
  try {
    await createAlertFixture({ confirmedLedger: ledger });
  } catch (error) {
    actualError = error;
  }

  if (actualError === undefined) {
    throw new Error("M4_PG_CONFIRMED_LEDGER_CHECK_NOT_ENFORCED");
  }
  if (!hasConfirmedLedgerConstraintEvidence(actualError)) {
    throw new Error("M4_PG_CONFIRMED_LEDGER_CONSTRAINT_NOT_IDENTIFIED", {
      cause: actualError,
    });
  }
}

async function cleanTransientFixtures(): Promise<void> {
  if (transientJobIds.length === 0 &&
      transientAlertIds.length === 0 && transientDeploymentIds.length === 0) {
    return;
  }
  if (!database) {
    const error = new Error("M4_PG_TRANSIENT_CLEANUP_CLIENT_UNAVAILABLE");
    cleanupFailure = true;
    cleanupFailureError ??= error;
    if (privilegesOnly) {
      const diagnostic = error instanceof Error
        ? `${error.name}:${error.message}`
            .replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted-url]")
        : "UNKNOWN_ERROR";
      console.error(`M4_PG_PRIVILEGES_QUERY_ERROR=${diagnostic}`);
    }
    throw error;
  }

  const client = database;
  const failures: unknown[] = [];
  if (transientJobIds.length > 0) {
    const ids = [...transientJobIds];
    try {
      await client.$transaction((tx) =>
        tx.anchorJob.deleteMany({ where: { id: { in: ids } } }));
      transientJobIds.length = 0;
    } catch (error) {
      failures.push(error);
    }
  }
  if (transientAlertIds.length > 0) {
    const ids = [...transientAlertIds];
    try {
      await client.$transaction((tx) =>
        tx.alert.deleteMany({ where: { id: { in: ids } } }));
      transientAlertIds.length = 0;
    } catch (error) {
      failures.push(error);
    }
  }
  if (transientDeploymentIds.length > 0) {
    const ids = [...transientDeploymentIds];
    try {
      await client.$transaction((tx) =>
        tx.anchorDeployment.deleteMany({ where: { id: { in: ids } } }));
      transientDeploymentIds.length = 0;
    } catch (error) {
      failures.push(error);
    }
  }

  if (failures.length > 0) {
    const error = new AggregateError(failures, "M4_PG_TRANSIENT_CLEANUP_FAILED");
    cleanupFailure = true;
    cleanupFailureError ??= error;
    throw error;
  }
}

beforeAll(async () => {
  database = createPrismaClient(target.url);
  try {
    await verifyLabIdentity(database);
    if (privilegesOnly) return;
    await verifyMigrationsAndEmptyFixtureTables(database);

    const keyPair = await generateKeyPair("ES256");
    const jwk = await exportJWK(keyPair.publicKey);
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" ||
        typeof jwk.x !== "string" || typeof jwk.y !== "string") {
      throw new Error("M4_PG_TEST_KEY_INVALID");
    }
    const publicJwk: Prisma.InputJsonValue = {
      kty: jwk.kty,
      crv: jwk.crv,
      x: jwk.x,
      y: jwk.y,
    };
    const thumbprint = await calculateJwkThumbprint(jwk, "sha256");
    const runId = randomUUID();
    testUserId = randomUUID();
    testKeyId = `m4-pg-${runId}`;
    signer = new JoseAlertSigner(keyPair.privateKey, testKeyId);

    await database.user.create({
      data: {
        id: testUserId,
        name: "SIMULACRO M4 PostgreSQL",
        email: `m4-${runId}@example.invalid`,
        role: "AUTHOR",
        status: "DISABLED",
      },
    });
    await database.publicKey.create({
      data: {
        kid: testKeyId,
        publicJwk,
        thumbprint,
        status: "ACTIVE",
        validFrom: new Date(Date.now() - 60_000),
      },
    });
    await createDeployment("ACTIVE", 1, false);
    service = new PrismaPublicAlertService(database);
  } catch (originalError) {
    try {
      await closeDatabaseAndCleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [originalError, cleanupError],
        "M4_PG_SETUP_AND_CLEANUP_FAILED",
      );
    }
    throw originalError;
  }
}, 30_000);

beforeEach(() => {
  assertFixtureCreationAllowed();
});

async function closeDatabaseAndCleanup(): Promise<void> {
  const client = database;
  if (!client) return;

  const failures: unknown[] = [];
  try {
    try {
      await cleanTransientFixtures();
    } catch (error) {
      failures.push(error);
    }

    if (primaryDeploymentId) {
      try {
        await client.anchorDeployment.deleteMany({
          where: { id: primaryDeploymentId },
        });
        primaryDeploymentId = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (testKeyId) {
      try {
        await client.publicKey.deleteMany({ where: { kid: testKeyId } });
        testKeyId = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
    if (testUserId) {
      try {
        await client.user.deleteMany({ where: { id: testUserId } });
        testUserId = undefined;
      } catch (error) {
        failures.push(error);
      }
    }
  } finally {
    try {
      await client.$disconnect();
    } catch (error) {
      failures.push(error);
    }
    database = undefined;
    service = undefined;
    signer = undefined;
  }

  if (cleanupFailure) {
    failures.unshift(new Error("M4_PG_EARLIER_CLEANUP_FAILURE", {
      cause: cleanupFailureError,
    }));
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "M4_PG_FINAL_CLEANUP_FAILED");
  }
}

afterEach(async ({ task }) => {
  try {
    await cleanTransientFixtures();
  } catch (cleanupError) {
    const testErrors = (task.result?.errors ?? []).map((error) =>
      new Error(error.message ?? "M4_PG_TEST_FAILED"));
    throw new AggregateError(
      [...testErrors, cleanupError],
      "M4_PG_TEST_AND_CLEANUP_FAILED",
    );
  }
});

afterAll(async () => {
  await closeDatabaseAndCleanup();
});

describe("M4 PostgreSQL integration (opt-in, disposable lab only)", () => {
  it("M4-PRIVILEGES-ONLY: verifica privilegios efectivos sin fixtures", () => {
    if (!privilegesOnly) return;
    expect(true).toBe(true);
  });

  it("PG-M4-01: lista, detalla y expone evidencia de una publicación confirmada", async () => {
    const fixture = await createAlertFixture();
    const listing = await requireService().list(1, 20);
    expect(listing.items.map((item) => item.id)).toContain(fixture.id);
    expect(listing.total).toBe(1);

    const detail = await requireService().get(fixture.id);
    const evidence = await requireService().anchor(fixture.id);
    expect(detail.alert.id).toBe(fixture.id);
    expect(detail.alert.lifecycleState).toBe("PUBLISHED");
    expect(evidence).toMatchObject({
      anchorStatus: "CONFIRMED",
      messageKeyHex: Buffer.from(fixture.messageKey).toString("hex"),
      jwsHashHex: Buffer.from(fixture.jwsHash).toString("hex"),
      verificationSource: "backend_metadata",
      checkedAt: null,
    });
  });

  it("PG-M4-02: excluye un jwsHash de AnchorJob incoherente", async () => {
    const fixture = await createAlertFixture({ jobJwsHashMismatch: true });
    await expectExcluded(fixture);
    for (const result of [
      requireService().get(fixture.id),
      requireService().anchor(fixture.id),
    ]) {
      await expect(result).rejects.toMatchObject({
        status: 503,
        code: "PUBLIC_DATA_UNAVAILABLE",
      });
    }
  });

  it("PG-M4-03: excluye un messageKey de AnchorJob diferente", async () => {
    const fixture = await createAlertFixture({ jobMessageKeyMismatch: true });
    await expectExcluded(fixture);
    for (const result of [
      requireService().get(fixture.id),
      requireService().anchor(fixture.id),
    ]) {
      await expect(result).rejects.toMatchObject({
        status: 503,
        code: "PUBLIC_DATA_UNAVAILABLE",
      });
    }
  });

  it.each(["", "   "])("PG-M4-04: excluye txHash vacío o blanco (%j)", async (txHash) => {
    const fixture = await createAlertFixture({ jobTxHash: txHash });
    await expectExcluded(fixture);
    await expect(requireService().anchor(fixture.id)).rejects.toMatchObject({
      status: 503,
      code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("PG-M4-05: excluye confirmedLedger nulo", async () => {
    const fixture = await createAlertFixture({ confirmedLedger: null });
    await expectExcluded(fixture);
    await expect(requireService().anchor(fixture.id)).rejects.toMatchObject({
      status: 503,
      code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("PG-M4-06a: identifica el rechazo PostgreSQL de confirmedLedger cero", async () => {
    await expectConfirmedLedgerCheckViolation(0n);
  });

  it("PG-M4-06b: identifica el rechazo PostgreSQL de confirmedLedger negativo", async () => {
    await expectConfirmedLedgerCheckViolation(-1n);
  });

  it("PG-M4-06c: acepta confirmedLedger positivo en un fixture válido", async () => {
    const fixture = await createAlertFixture({ confirmedLedger: 1n });
    const evidence = await requireService().anchor(fixture.id);
    expect(evidence.anchorStatus).toBe("CONFIRMED");
    expect(evidence.jwsHashHex).toBe(Buffer.from(fixture.jwsHash).toString("hex"));
  });

  it("PG-M4-07: excluye una alerta con jobs de deployments distintos", async () => {
    const fixture = await createAlertFixture({ additionalJob: true });
    await expectExcluded(fixture);
    await expect(requireService().anchor(fixture.id)).rejects.toMatchObject({
      status: 503,
      code: "PUBLIC_DATA_UNAVAILABLE",
    });
  });

  it("PG-M4-08: pagina solo registros elegibles y mantiene total y orden estable", async () => {
    const first = await createAlertFixture({
      publishedAt: new Date("2026-10-20T14:35:00.000Z"),
    });
    await createAlertFixture({
      jobJwsHashMismatch: true,
      publishedAt: new Date("2026-10-20T14:34:00.000Z"),
    });
    const second = await createAlertFixture({
      publishedAt: new Date("2026-10-20T14:33:00.000Z"),
    });

    const pageOne = await requireService().list(1, 1);
    const pageTwo = await requireService().list(2, 1);
    const pageThree = await requireService().list(3, 1);
    const pageIds = [...pageOne.items, ...pageTwo.items].map((item) => item.id);
    expect(pageOne.total).toBe(2);
    expect(pageTwo.total).toBe(2);
    expect(pageThree).toEqual({ items: [], page: 3, total: 2 });
    expect(pageIds).toEqual([first.id, second.id]);
    expect(new Set(pageIds).size).toBe(pageIds.length);
  });

  it("PG-M4-09: no lista una alerta SIGNED_PENDING_ANCHOR", async () => {
    const fixture = await createAlertFixture({
      lifecycleState: "SIGNED_PENDING_ANCHOR",
      anchorStatus: "PENDING",
      jobState: "PENDING",
    });
    await expectExcluded(fixture);
    await expect(requireService().get(fixture.id)).rejects.toMatchObject({
      status: 404,
      code: "PUBLIC_ALERT_NOT_FOUND",
    });
    await expect(requireService().anchor(fixture.id)).rejects.toMatchObject({
      status: 404,
      code: "PUBLIC_ALERT_NOT_FOUND",
    });
  });

  it("PG-M4-10: listado, detalle y evidencia coinciden para una alerta válida", async () => {
    const fixture = await createAlertFixture();
    const [listing, detail, evidence] = await Promise.all([
      requireService().list(1, 20),
      requireService().get(fixture.id),
      requireService().anchor(fixture.id),
    ]);
    expect(listing.total).toBe(1);
    expect(listing.items[0]?.id).toBe(detail.alert.id);
    expect(detail.anchorEvidenceMeta).toEqual(evidence);
  });

  it.todo("PG-M4-11: requiere un rol lector separado con SELECT denegado, preparado fuera del harness");
});
