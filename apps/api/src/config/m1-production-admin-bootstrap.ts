import { isIP } from "node:net";
import { Client } from "pg";

const activationLifetimeMs = 15 * 60_000;

export interface M1ProductionAdminBootstrapConfig {
  readonly databaseUrl: string;
  readonly databaseHost: string;
  readonly databaseName: string;
  readonly databaseUser: string;
  readonly targetId: string;
  readonly totpKey: Uint8Array;
  readonly expiresAt: Date;
}

export class M1ProductionAdminBootstrapError extends Error {
  override readonly name = "M1ProductionAdminBootstrapError";
  constructor(readonly code: string) { super(code); }
}

export function readM1ProductionAdminBootstrapConfig(
  source: NodeJS.ProcessEnv,
  now = new Date(),
): M1ProductionAdminBootstrapConfig {
  if (source["SIGAE_M1_ADMIN_BOOTSTRAP_ENABLED"] !== "true") {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_NOT_ENABLED");
  }
  const expiryText = source["SIGAE_M1_ADMIN_BOOTSTRAP_EXPIRES_AT"];
  const databaseUrl = source["DATABASE_URL"];
  const databaseHost = source["SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_HOST"]?.toLowerCase();
  const databaseName = source["SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_NAME"];
  const databaseUser = source["SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_USER"];
  const targetId = source["SIGAE_M1_ADMIN_BOOTSTRAP_TARGET_ID"]?.toLowerCase();
  const keyText = source["TOTP_ENCRYPTION_KEY"];

  if (!expiryText || !databaseUrl || !databaseHost || !databaseName || !databaseUser ||
      !targetId || !keyText || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(targetId)) {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  }

  const expiresAt = new Date(expiryText);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.toISOString() !== expiryText ||
      expiresAt <= now || expiresAt.getTime() > now.getTime() + activationLifetimeMs) {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_WINDOW_INVALID");
  }

  let url: URL;
  let username: string;
  let databasePath: string;
  try {
    url = new URL(databaseUrl);
    username = decodeURIComponent(url.username);
    databasePath = decodeURIComponent(url.pathname.slice(1));
  } catch {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_TARGET_INVALID");
  }
  const parameters = [...url.searchParams.entries()];
  if ((url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
      url.hostname !== databaseHost || isIP(databaseHost) !== 0 ||
      databaseHost === "localhost" || databaseHost.endsWith(".localhost") ||
      !isValidDatabaseHost(databaseHost) || !url.password ||
      databasePath !== databaseName ||
      username !== databaseUser || parameters.length !== 1 ||
      parameters[0]?.[0] !== "sslmode" || parameters[0][1] !== "require" ||
      url.hash !== "") {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_TARGET_INVALID");
  }

  if (!/^[a-z][a-z0-9_]{0,62}$/u.test(databaseName) ||
      !/^[a-z][a-z0-9_]{0,62}$/u.test(databaseUser) ||
      !/^[A-Za-z0-9._~-]{32,64}$/u.test(keyText)) {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_CONFIGURATION_INVALID");
  }
  const totpKey = Buffer.from(keyText, "base64url");
  if (totpKey.length !== 32 || totpKey.toString("base64url") !== keyText) {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_KEY_INVALID");
  }

  return Object.freeze({
    databaseUrl,
    databaseHost,
    databaseName,
    databaseUser,
    targetId,
    totpKey,
    expiresAt,
  });
}

export function validateM1ProductionAdminBootstrapProfile(
  source: NodeJS.ProcessEnv,
  now = new Date(),
): void {
  readM1ProductionAdminBootstrapConfig(source, now);
}

export async function assertM1ProductionAdminBootstrapTarget(
  config: M1ProductionAdminBootstrapConfig,
): Promise<void> {
  const client = new Client({
    connectionString: config.databaseUrl,
    connectionTimeoutMillis: 5_000,
    query_timeout: 5_000,
    statement_timeout: 5_000,
  });
  let connected = false;
  try {
    await client.connect();
    connected = true;
    const result = await client.query<{
      databaseName: string;
      username: string;
      address: string | null;
      marker: string | null;
      isTls: boolean;
      superuser: boolean;
      createDatabase: boolean;
      createRole: boolean;
      replication: boolean;
      bypassRls: boolean;
      roleHasMemberships: boolean;
      databaseOwner: boolean;
      databaseCreate: boolean;
      schemaCreate: boolean;
      hasRequiredPrivileges: boolean;
      noDestructivePrivileges: boolean;
      auditHeadExists: boolean;
    }>(`
      SELECT current_database() AS "databaseName", current_user AS username,
        host(inet_server_addr()) AS address,
        shobj_description(d.oid, 'pg_database') AS marker,
        COALESCE((SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()), false) AS "isTls",
        role.rolsuper AS superuser, role.rolcreatedb AS "createDatabase",
        role.rolcreaterole AS "createRole", role.rolreplication AS replication,
        role.rolbypassrls AS "bypassRls",
        EXISTS (SELECT 1 FROM pg_auth_members WHERE member = role.oid) AS "roleHasMemberships",
        pg_get_userbyid(d.datdba) = current_user AS "databaseOwner",
        has_database_privilege(current_user, current_database(), 'CREATE') AS "databaseCreate",
        has_schema_privilege(current_user, 'public', 'CREATE') AS "schemaCreate",
        (SELECT bool_and(has_table_privilege(current_user,
          format('%I.%I', 'public', privilege.table_name), privilege.privilege))
          FROM (VALUES
            ('users', 'SELECT'), ('users', 'INSERT'), ('users', 'UPDATE'),
            ('identity_bootstrap', 'SELECT'), ('identity_bootstrap', 'INSERT'),
            ('identity_invitations', 'INSERT'), ('identity_invitations', 'UPDATE'),
            ('identity_challenges', 'INSERT'), ('identity_challenges', 'UPDATE'),
            ('audit_events', 'INSERT'), ('audit_chain_state', 'SELECT'), ('audit_chain_state', 'UPDATE')
          ) AS privilege(table_name, privilege)) AS "hasRequiredPrivileges",
        (SELECT bool_and(NOT has_table_privilege(current_user,
          format('%I.%I', 'public', privilege.table_name), privilege.privilege))
          FROM (VALUES
            ('users', 'DELETE'), ('users', 'TRUNCATE'), ('users', 'REFERENCES'), ('users', 'TRIGGER'),
            ('identity_bootstrap', 'DELETE'), ('identity_bootstrap', 'TRUNCATE'),
            ('identity_invitations', 'DELETE'), ('identity_invitations', 'TRUNCATE'),
            ('identity_challenges', 'DELETE'), ('identity_challenges', 'TRUNCATE'),
            ('audit_events', 'DELETE'), ('audit_events', 'TRUNCATE'),
            ('audit_chain_state', 'DELETE'), ('audit_chain_state', 'TRUNCATE')
          ) AS privilege(table_name, privilege)) AS "noDestructivePrivileges",
        EXISTS (SELECT 1 FROM audit_chain_state WHERE id = 1) AS "auditHeadExists"
      FROM pg_database AS d
      JOIN pg_roles AS role ON role.rolname = current_user
      WHERE d.datname = current_database()
    `);
    const row = result.rows[0];
    if (result.rowCount !== 1 || !row ||
        row.databaseName !== config.databaseName || row.username !== config.databaseUser ||
        !row.address || isIP(row.address) === 0 || isLoopbackAddress(row.address) ||
        row.marker !== `SIGAE_M1_ADMIN_BOOTSTRAP:${config.targetId}` ||
        !row.isTls || row.superuser || row.createDatabase || row.createRole || row.replication || row.bypassRls ||
        row.roleHasMemberships || row.databaseOwner || row.databaseCreate || row.schemaCreate ||
        !row.hasRequiredPrivileges || !row.noDestructivePrivileges || !row.auditHeadExists) {
      throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_TARGET_REJECTED");
    }
  } catch (error) {
    if (error instanceof M1ProductionAdminBootstrapError) throw error;
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_TARGET_UNAVAILABLE");
  } finally {
    if (connected) await client.end();
  }
}

function isLoopbackAddress(value: string): boolean {
  return value === "::1" || value === "127.0.0.1" || value.startsWith("127.") ||
    value.toLowerCase().startsWith("::ffff:127.");
}

function isValidDatabaseHost(value: string): boolean {
  return value.length <= 253 && value.split(".").every((label) =>
    label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label));
}
