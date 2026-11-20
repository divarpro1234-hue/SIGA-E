import type { Prisma, PrismaClient } from "../generated/prisma/client.js";
import { createPrismaClient } from "../infrastructure/database/prisma-client.js";

export const M2_HTTP_DATABASE_NAME = "sigae_m2_http_itest";
export const M2_HTTP_RUNTIME_ROLE = "sigae_m2_http_itest";
export const M2_HTTP_MIGRATOR_ROLE = "sigae_m2_http_migrator";
export const M2_HTTP_DATABASE_MARKER =
  "SIGAE_M2_HTTP_POSTGRES_LAB_V1;MIGRATIONS=20261011_initial,20261012_m1_identity_additive,20261021_m2_approval_snapshot;EMPTY=1";
export const M2_HTTP_WRITE_OPT_IN = "I_ACKNOWLEDGE_M2_HTTP_WRITES";

const databaseUrlPattern =
  /^postgres(?:ql)?:\/\/sigae_m2_http_itest:[A-Za-z0-9._~-]+@127\.0\.0\.1:55432\/sigae_m2_http_itest(?![\s\S])/u;

const forbiddenConnectionVariables = [
  "DATABASE_URL",
  "DIRECT_URL",
  "PRISMA_DATABASE_URL",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGTARGETSESSIONATTRS",
] as const;

const expectedRelations = [
  "_prisma_migrations",
  "alerts",
  "alert_references",
  "approvals",
  "anchor_deployments",
  "anchor_jobs",
  "audit_chain_state",
  "audit_events",
  "identity_bootstrap",
  "identity_challenges",
  "identity_invitations",
  "identity_rate_limits",
  "public_keys",
  "sessions",
  "users",
] as const;

const expectedTablePrivileges = new Map<string, ReadonlySet<string>>([
  ["users", new Set(["SELECT", "INSERT"])],
  ["sessions", new Set(["SELECT", "INSERT"])],
  ["alerts", new Set(["SELECT", "INSERT", "UPDATE"])],
  ["approvals", new Set(["SELECT", "INSERT"])],
  ["audit_events", new Set(["SELECT", "INSERT"])],
  ["audit_chain_state", new Set(["SELECT", "UPDATE"])],
]);

const expectedColumnUpdates = new Set(["users.created_at", "sessions.last_seen_at"]);
const tableLevelUpdateRelations = new Set(["alerts", "audit_chain_state"]);

export class M2HttpIntegrationDatabaseError extends Error {
  override readonly name = "M2HttpIntegrationDatabaseError";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function validateM2HttpIntegrationDatabase(source: unknown): string {
  if (!isPlainObject(source) ||
      Reflect.ownKeys(source).length !== 1 ||
      !Object.hasOwn(source, "SIGAE_M2_HTTP_DATABASE_URL")) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_DATABASE_CONFIGURATION_REJECTED");
  }
  const databaseUrl = source["SIGAE_M2_HTTP_DATABASE_URL"];
  if (typeof databaseUrl !== "string" || !databaseUrlPattern.test(databaseUrl)) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_DATABASE_CONFIGURATION_REJECTED");
  }
  return databaseUrl;
}

export function createM2HttpIntegrationDatabaseClient(
  source: NodeJS.ProcessEnv = process.env,
): PrismaClient {
  if (source["SIGAE_RUN_M2_HTTP_POSTGRES"] !== M2_HTTP_WRITE_OPT_IN) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_OPERATOR_OPT_IN_REQUIRED");
  }
  if (forbiddenConnectionVariables.some((name) => source[name] !== undefined) ||
      Object.keys(source).some((name) => name.startsWith("PG"))) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_GENERIC_DATABASE_VARIABLE_REJECTED");
  }
  const databaseUrl = validateM2HttpIntegrationDatabase({
    SIGAE_M2_HTTP_DATABASE_URL: source["SIGAE_M2_HTTP_DATABASE_URL"],
  });
  return createPrismaClient(databaseUrl);
}

export async function assertM2HttpTarget(tx: Prisma.TransactionClient): Promise<void> {
  const identity = await tx.$queryRaw<Array<{
    db: string;
    username: string;
    address: string | null;
    port: number | null;
    zone: string;
    marker: string | null;
    databaseOwner: string;
    canLogin: boolean;
    superuser: boolean;
    createDatabase: boolean;
    createRole: boolean;
    bypassRls: boolean;
    hasMemberships: boolean;
    schemaUsage: boolean;
    schemaCreate: boolean;
    databaseCreate: boolean;
  }>>`
    SELECT current_database() AS db, current_user AS username,
      host(inet_server_addr()) AS address, inet_server_port() AS port,
      current_setting('TimeZone') AS zone,
      shobj_description(database.oid, 'pg_database') AS marker,
      pg_get_userbyid(database.datdba) AS "databaseOwner",
      role.rolcanlogin AS "canLogin", role.rolsuper AS superuser,
      role.rolcreatedb AS "createDatabase", role.rolcreaterole AS "createRole",
      role.rolbypassrls AS "bypassRls",
      EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid) AS "hasMemberships",
      has_schema_privilege(current_user, 'public', 'USAGE') AS "schemaUsage",
      has_schema_privilege(current_user, 'public', 'CREATE') AS "schemaCreate",
      has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate"
    FROM pg_database AS database
    JOIN pg_roles AS role ON role.rolname = current_user
    WHERE database.datname = current_database()
  `;
  const target = identity[0];
  if (identity.length !== 1 || !target ||
      target.db !== M2_HTTP_DATABASE_NAME ||
      target.username !== M2_HTTP_RUNTIME_ROLE ||
      target.address !== "127.0.0.1" ||
      target.port !== 55432 ||
      target.zone !== "UTC" ||
      target.marker !== M2_HTTP_DATABASE_MARKER ||
      target.databaseOwner !== M2_HTTP_MIGRATOR_ROLE ||
      !target.canLogin || target.superuser || target.createDatabase ||
      target.createRole || target.bypassRls || target.hasMemberships ||
      !target.schemaUsage || target.schemaCreate || target.databaseCreate) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_TARGET_IDENTITY_REJECTED");
  }

  const relations = await tx.$queryRaw<Array<{ name: string; owner: string }>>`
    SELECT relation.relname AS name, pg_get_userbyid(relation.relowner) AS owner
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
  `;
  const relationNames = relations.map((relation) => relation.name).sort();
  if (JSON.stringify(relationNames) !== JSON.stringify([...expectedRelations].sort()) ||
      relations.some((relation) => relation.owner !== M2_HTTP_MIGRATOR_ROLE)) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_SCHEMA_RELATIONS_REJECTED");
  }

  const tablePrivileges = await tx.$queryRaw<Array<{
    tableName: string;
    privilege: string;
    granted: boolean;
  }>>`
    SELECT relation.relname AS "tableName", requested.privilege,
      has_table_privilege(current_user, relation.oid, requested.privilege) AS granted
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']::text[])
      AS requested(privilege)
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
  `;
  for (const grant of tablePrivileges) {
    const expected = expectedTablePrivileges.get(grant.tableName)?.has(grant.privilege) ?? false;
    if (grant.granted !== expected) {
      throw new M2HttpIntegrationDatabaseError("M2_HTTP_TABLE_PRIVILEGES_REJECTED");
    }
  }

  const columnUpdates = await tx.$queryRaw<Array<{
    tableName: string;
    columnName: string;
    granted: boolean;
  }>>`
    SELECT relation.relname AS "tableName", attribute.attname AS "columnName",
      has_column_privilege(current_user, relation.oid, attribute.attnum, 'UPDATE') AS granted
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    JOIN pg_attribute AS attribute ON attribute.attrelid = relation.oid
    WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0 AND NOT attribute.attisdropped
  `;
  for (const grant of columnUpdates) {
    const expected = tableLevelUpdateRelations.has(grant.tableName) ||
      expectedColumnUpdates.has(`${grant.tableName}.${grant.columnName}`);
    if (grant.granted !== expected) {
      throw new M2HttpIntegrationDatabaseError("M2_HTTP_COLUMN_PRIVILEGES_REJECTED");
    }
  }

  const requiredColumns = await tx.$queryRaw<Array<{ tableName: string; columnName: string }>>`
    WITH required(table_name, column_name) AS (
      VALUES
        ('users', 'last_totp_step'),
        ('sessions', 'token_hash'),
        ('sessions', 'last_seen_at'),
        ('alerts', 'version'),
        ('alerts', 'lifecycle_state'),
        ('alerts', 'frozen_payload'),
        ('alerts', 'payload_sha256'),
        ('alerts', 'approved_payload_sha256'),
        ('approvals', 'alert_version'),
        ('approvals', 'reviewed_payload'),
        ('approvals', 'reason')
    )
    SELECT required.table_name AS "tableName", required.column_name AS "columnName"
    FROM required
    LEFT JOIN information_schema.columns AS column_info
      ON column_info.table_schema = 'public'
      AND column_info.table_name = required.table_name
      AND column_info.column_name = required.column_name
    WHERE column_info.column_name IS NULL
  `;
  const migrationArtifacts = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT to_regclass('public._prisma_migrations') IS NOT NULL
      AND to_regclass('public.identity_invitations') IS NOT NULL
      AND to_regclass('public.identity_challenges') IS NOT NULL
      AND to_regclass('public.identity_bootstrap') IS NOT NULL
      AND to_regclass('public.identity_rate_limits') IS NOT NULL
      AND to_regclass('public.approvals_alert_id_alert_version_key') IS NOT NULL AS present
  `;
  const genesis = await tx.$queryRaw<Array<{ rowCount: bigint; valid: boolean }>>`
    SELECT count(*) AS "rowCount",
      bool_and(id = 1 AND last_seq = 0 AND last_hash = decode(repeat('00', 32), 'hex')) AS valid
    FROM public.audit_chain_state
  `;
  if (requiredColumns.length !== 0 ||
      migrationArtifacts[0]?.present !== true ||
      genesis.length !== 1 ||
      genesis[0]?.rowCount !== 1n ||
      genesis[0]?.valid !== true) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_SCHEMA_SIGNATURE_REJECTED");
  }
}

export async function assertM2HttpFreshLab(tx: Prisma.TransactionClient): Promise<void> {
  const rows = await tx.$queryRaw<Array<{
    usersEmpty: boolean;
    sessionsEmpty: boolean;
    alertsEmpty: boolean;
    approvalsEmpty: boolean;
    auditEventsEmpty: boolean;
  }>>`
    SELECT
      (SELECT count(*) = 0 FROM public.users) AS "usersEmpty",
      (SELECT count(*) = 0 FROM public.sessions) AS "sessionsEmpty",
      (SELECT count(*) = 0 FROM public.alerts) AS "alertsEmpty",
      (SELECT count(*) = 0 FROM public.approvals) AS "approvalsEmpty",
      (SELECT count(*) = 0 FROM public.audit_events) AS "auditEventsEmpty"
  `;
  const empty = rows[0];
  if (rows.length !== 1 || !empty || Object.values(empty).some((value) => value !== true)) {
    throw new M2HttpIntegrationDatabaseError("M2_HTTP_LAB_NOT_EMPTY");
  }
}
