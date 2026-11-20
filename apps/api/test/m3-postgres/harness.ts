import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Client } from "pg";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import {
  hasM3IssueTablePrivilegeState,
  isM3IssueTarget,
  M3_ISSUE_LAB_ID,
  validateM3IssueIntegrationDatabase,
  type M3IssueTargetEvidence,
  type M3IssueTablePrivilegeEvidence,
} from "../../src/config/m3-issue-integration-database.js";
import { createPrismaClient } from "../../src/infrastructure/database/prisma-client.js";
import { PrismaDraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import type { AlertSigningKeyProvider } from "../../src/modules/signing/alert-signing-key-provider.js";
import type { InternalUser } from "../../src/modules/identity/session-reader.js";

const deploymentMarker = "SIMULACRO-LOCAL-M3-ISSUE-";
const deploymentConfigMarker = "SIMULACRO-LOCAL-M3-ISSUE-v1";
const keyMarker = "m3-issue-synthetic-";
const denied = () => new Error("M3_ISSUE_HARNESS_DESTINATION_REJECTED");
const targetQuery = `
  SELECT d.datname AS "databaseName", r.rolname AS "username",
    session_user AS "sessionUsername", host(inet_server_addr()) AS address,
    inet_server_port() AS port, current_setting('TimeZone') AS timezone,
    shobj_description(d.oid, 'pg_database') AS "labMarker",
    r.rolsuper AS "isSuperuser", r.rolcreatedb AS "canCreateDatabase",
    r.rolcreaterole AS "canCreateRole", r.rolreplication AS "canReplicate",
    r.rolbypassrls AS "canBypassRls", d.datdba = r.oid AS "isDatabaseOwner",
    has_database_privilege(r.oid, d.oid, 'CREATE') AS "canCreateInDatabase",
    has_schema_privilege(r.oid, 'public', 'USAGE') AS "canUsePublicSchema",
    has_schema_privilege(r.oid, 'public', 'CREATE') AS "canCreateInPublicSchema",
    EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relowner = r.oid
    ) AS "ownsPublicObjects",
    EXISTS (
      SELECT 1 FROM pg_auth_members m
      WHERE m.member = r.oid
    ) AS "hasRoleMembership"
  FROM pg_database d
  JOIN pg_roles r ON r.rolname = current_user
  WHERE d.datname = current_database() AND session_user = current_user
`;
const tablePrivilegeQuery = `
  SELECT c.relname AS "tableName", pg_get_userbyid(c.relowner) AS owner,
    privileges.name AS privilege,
    has_table_privilege(current_user, c.oid, privileges.name) AS granted
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  CROSS JOIN (VALUES
    ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'),
    ('REFERENCES'), ('TRIGGER'), ('MAINTAIN')
  ) AS privileges(name)
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  ORDER BY c.relname, privileges.name
`;

export interface M3PostgresLab {
  readonly writer: PrismaClient;
  readonly observer: PrismaClient;
  readonly lockClient: Client;
}

export interface M3SyntheticActor {
  readonly actor: InternalUser;
  readonly cookie: string;
  readonly runId: string;
}

async function assertTargetRows(rows: readonly M3IssueTargetEvidence[]): Promise<void> {
  if (rows.length !== 1 || !isM3IssueTarget(rows[0])) throw denied();
}

function assertTablePrivilegeRows(rows: readonly M3IssueTablePrivilegeEvidence[]): void {
  if (!hasM3IssueTablePrivilegeState(rows)) throw denied();
}

export async function assertM3IssueTarget(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRawUnsafe<M3IssueTargetEvidence[]>(targetQuery);
  await assertTargetRows(rows);
  const privileges = await tx.$queryRawUnsafe<M3IssueTablePrivilegeEvidence[]>(tablePrivilegeQuery);
  assertTablePrivilegeRows(privileges);
}

export async function openM3IssueLab(): Promise<M3PostgresLab> {
  if (process.env["SIGAE_RUN_M3_POSTGRES_ISSUE"] !== "I_ACKNOWLEDGE_M3_ISSUE_WRITES") {
    throw denied();
  }
  if (process.env["DATABASE_URL"] !== undefined || process.env["DIRECT_URL"] !== undefined ||
      Object.keys(process.env).some((name) => name.startsWith("PG") || name.startsWith("NEON_"))) {
    throw denied();
  }
  const databaseUrl = validateM3IssueIntegrationDatabase({
    SIGAE_M3_POSTGRES_URL: process.env["SIGAE_M3_POSTGRES_URL"],
    ...(process.env["SIGAE_M3_POSTGRES_DIRECT_URL"] === undefined
      ? {}
      : { SIGAE_M3_POSTGRES_DIRECT_URL: process.env["SIGAE_M3_POSTGRES_DIRECT_URL"] }),
    SIGAE_M3_POSTGRES_LAB_ID: process.env["SIGAE_M3_POSTGRES_LAB_ID"],
  });
  if (process.env["SIGAE_M3_POSTGRES_LAB_ID"] !== M3_ISSUE_LAB_ID) throw denied();
  const writer = createPrismaClient(databaseUrl);
  const observer = createPrismaClient(databaseUrl);
  const lockClient = new Client({ connectionString: databaseUrl });
  try {
    await lockClient.connect();
    await lockClient.query("SET TIME ZONE 'UTC'");
    const target = await lockClient.query<M3IssueTargetEvidence>(targetQuery);
    await assertTargetRows(target.rows);
    const privileges = await lockClient.query<M3IssueTablePrivilegeEvidence>(tablePrivilegeQuery);
    assertTablePrivilegeRows(privileges.rows);
    const lock = await lockClient.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock($1::integer, $2::integer) AS locked",
      [1_397_311_299, 1_295_310_851],
    );
    if (lock.rows.length !== 1 || lock.rows[0]?.locked !== true) {
      throw new Error("M3_ISSUE_HARNESS_ALREADY_RUNNING");
    }
    return { writer, observer, lockClient };
  } catch (error) {
    await lockClient.end().catch(() => undefined);
    await Promise.all([writer.$disconnect(), observer.$disconnect()]);
    if (error instanceof Error && error.message === "M3_ISSUE_HARNESS_ALREADY_RUNNING") throw error;
    throw denied();
  }
}

export type M3FailurePoint =
  | "none"
  | "after_alert_update"
  | "during_anchor_job_create"
  | "after_anchor_job_create"
  | "after_audit_create";
export interface M3FailureEvidence {
  afterAlertUpdate: boolean;
  afterAnchorJobCreate: boolean;
  afterAuditCreate: boolean;
}

export function guardedIssueService(
  prisma: PrismaClient,
  provider: AlertSigningKeyProvider | undefined,
  failure: M3FailurePoint = "none",
  failureEvidence?: M3FailureEvidence,
) {
  const facade = {
    async $transaction<T>(
      work: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<T> {
      return prisma.$transaction(async (tx) => {
        await assertM3IssueTarget(tx);
        if (failure === "none") return work(tx);
        const failingTx = new Proxy(tx, {
          get(target, property) {
            const value: unknown = Reflect.get(target, property, target);
            if (!value || typeof value !== "object") {
              return typeof value === "function" ? value.bind(target) : value;
            }
            if (property !== "alert" && property !== "anchorJob" && property !== "auditEvent") {
              return value;
            }
            return new Proxy(value, {
              get(delegate, operation, object) {
                const operationValue: unknown = Reflect.get(delegate, operation, object);
                if (typeof operationValue !== "function") {
                  return typeof operationValue === "function" ? operationValue.bind(delegate) : operationValue;
                }
                if (property === "alert" && operation === "updateMany" &&
                    failure === "after_alert_update") {
                  return async (...args: unknown[]) => {
                    const result = await operationValue.apply(delegate, args);
                    if (failureEvidence) failureEvidence.afterAlertUpdate = true;
                    throw new Error("M3_ISSUE_INJECTED_ROLLBACK");
                  };
                }
                if (property === "anchorJob" && operation === "create" &&
                    (failure === "during_anchor_job_create" || failure === "after_anchor_job_create")) {
                  return async (...args: unknown[]) => {
                    if (failure === "during_anchor_job_create") {
                      throw new Error("M3_ISSUE_INJECTED_ANCHOR_JOB_FAILURE");
                    }
                    const result = await operationValue.apply(delegate, args);
                    if (failureEvidence) failureEvidence.afterAnchorJobCreate = true;
                    throw new Error("M3_ISSUE_INJECTED_ROLLBACK");
                  };
                }
                if (property === "auditEvent" && operation === "create" && failure === "after_audit_create") {
                  return async (...args: unknown[]) => {
                    const result = await operationValue.apply(delegate, args);
                    if (failureEvidence) failureEvidence.afterAuditCreate = true;
                    throw new Error("M3_ISSUE_INJECTED_ROLLBACK");
                  };
                }
                return operationValue.bind(delegate);
              },
            });
          },
        });
        return work(failingTx);
      }, options);
    },
  };
  return new PrismaDraftAlertService(
    facade as unknown as PrismaClient,
    "urn:siga-e:simulacro",
    undefined,
    undefined,
    undefined,
    provider,
  );
}

export async function guardedRead<T>(
  prisma: PrismaClient,
  read: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await assertM3IssueTarget(tx);
    return read(tx);
  }, { isolationLevel: "RepeatableRead" });
}

export async function guardedWrite<T>(
  prisma: PrismaClient,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await assertM3IssueTarget(tx);
    return write(tx);
  }, { isolationLevel: "Serializable" });
}

async function seedSyntheticActor(
  prisma: PrismaClient,
  role: "AUTHOR" | "APPROVER",
): Promise<M3SyntheticActor> {
  const runId = randomUUID();
  const actor: InternalUser = {
    id: randomUUID(),
    name: role === "AUTHOR" ? "SIMULACRO Autor M3" : "SIMULACRO Aprobador M3",
    email: `m3-${role.toLowerCase()}-${runId}@example.invalid`,
    role,
    status: "ACTIVE",
  };
  const token = randomBytes(32).toString("base64url");
  const now = new Date();

  await guardedWrite(prisma, async (tx) => {
    await tx.user.create({
      data: {
        id: actor.id,
        name: actor.name,
        email: actor.email,
        role,
        status: "ACTIVE",
        passwordHash: `SIMULACRO-NO-LOGIN-${runId}`,
        totpSecretCiphertext: randomBytes(32),
      },
    });
    await tx.session.create({
      data: {
        userId: actor.id,
        tokenHash: createHash("sha256").update(token, "ascii").digest(),
        lastSeenAt: now,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
      },
    });
  });

  return { actor, cookie: `sigae_session=${token}`, runId };
}

export function seedM3Actor(prisma: PrismaClient): Promise<M3SyntheticActor> {
  return seedSyntheticActor(prisma, "AUTHOR");
}

export function seedM3Approver(prisma: PrismaClient): Promise<M3SyntheticActor> {
  return seedSyntheticActor(prisma, "APPROVER");
}

export async function ensureSyntheticDeployment(prisma: PrismaClient): Promise<string> {
  return prisma.$transaction(async (tx) => {
    await assertM3IssueTarget(tx);
    const active = await tx.anchorDeployment.findMany({
      where: { state: "ACTIVE" },
      select: { id: true, contractId: true, trustedConfigVersion: true },
      orderBy: { generation: "asc" },
      take: 2,
    });
    if (active.length > 1) throw new Error("M3_ISSUE_HARNESS_DEPLOYMENT_AMBIGUOUS");
    const existing = active[0];
    if (existing) {
      if (existing.contractId.startsWith(deploymentMarker) &&
          existing.trustedConfigVersion === deploymentConfigMarker) return existing.id;
      throw new Error("M3_ISSUE_HARNESS_FOREIGN_DEPLOYMENT_ACTIVE");
    }

    const maximum = await tx.anchorDeployment.aggregate({
      where: { network: "TESTNET" },
      _max: { generation: true },
    });
    const generation = (maximum._max.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1 || generation > 2_147_483_647) {
      throw new Error("M3_ISSUE_HARNESS_DEPLOYMENT_GENERATION_INVALID");
    }
    const marker = randomUUID();
    const synthetic = await tx.anchorDeployment.create({
      data: {
        network: "TESTNET",
        networkPassphrase: "SIMULACRO-LOCAL-NO-NETWORK",
        contractId: `${deploymentMarker}${marker}`,
        wasmHash: createHash("sha256").update(`M3-ISSUE-SYNTHETIC-WASM-v1:${marker}`, "utf8").digest("hex"),
        adminPublicAddress: `SIMULACRO-LOCAL-NO-ACCOUNT-${marker}`,
        generation,
        state: "ACTIVE",
        deployedAt: new Date(),
        trustedConfigVersion: deploymentConfigMarker,
      },
      select: { id: true },
    });
    return synthetic.id;
  }, { isolationLevel: "Serializable" });
}

export async function seedSyntheticPublicKey(
  prisma: PrismaClient,
  kid: string,
  publicJwk: Prisma.InputJsonValue,
  thumbprint: string,
): Promise<void> {
  if (!kid.startsWith(keyMarker)) throw denied();
  await prisma.$transaction(async (tx) => {
    await assertM3IssueTarget(tx);
    const active = await tx.publicKey.findMany({
      where: { status: "ACTIVE" },
      select: { kid: true },
    });
    if (active.some((key) => !key.kid.startsWith(keyMarker))) {
      throw new Error("M3_ISSUE_HARNESS_FOREIGN_PUBLIC_KEY_ACTIVE");
    }
    await tx.publicKey.updateMany({
      where: { status: "ACTIVE", kid: { startsWith: keyMarker } },
      data: { status: "RETIRED", retiredAt: new Date() },
    });
    await tx.publicKey.create({
      data: {
        kid,
        publicJwk,
        thumbprint,
        status: "ACTIVE",
        validFrom: new Date(Date.now() - 1_000),
      },
    });
  }, { isolationLevel: "Serializable" });
}

export function evidence(runId: string, alertId: string, outcome: string): void {
  process.stdout.write(`M3 SIMULACRO run=${runId} alert=${alertId} outcome=${outcome}\n`);
}
