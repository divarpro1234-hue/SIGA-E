export const ANCHOR_OPERATOR_DATABASE = "sigae_m5_anchor_operator";
export const ANCHOR_OPERATOR_RUNTIME_ROLE = "sigae_m5_anchor_operator";
export const ANCHOR_OPERATOR_MIGRATOR_ROLE = "sigae_m5_anchor_migrator";
export const ANCHOR_OPERATOR_LAB_ID = "SIGAE_M5_ANCHOR_OPERATOR_V1";
export const ANCHOR_OPERATOR_URL_ENV = "SIGAE_M5_ANCHOR_OPERATOR_URL";
export const ANCHOR_OPERATOR_MIGRATOR_URL_ENV = "SIGAE_M5_ANCHOR_OPERATOR_MIGRATOR_URL";
export const ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV = "SIGAE_APPLY_M5_ANCHOR_OPERATOR_MIGRATIONS";
export const ANCHOR_OPERATOR_MIGRATIONS_OPT_IN = "I_ACKNOWLEDGE_M5_ANCHOR_OPERATOR_MIGRATIONS";
export const ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_ENV =
  "SIGAE_M5_ANCHOR_OPERATOR_MIGRATION_PREFLIGHT";
export const ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_OPT_IN =
  "I_ACKNOWLEDGE_M5_ANCHOR_OPERATOR_READ_ONLY_PREFLIGHT";

export class AnchorOperatorDatabaseError extends Error {
  override readonly name = "AnchorOperatorDatabaseError";
}

export function sanitizeAnchorOperatorDatabaseErrorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code: unknown = Reflect.get(error, "code");
  if (typeof code !== "string") return null;
  switch (code) {
    case "28P01":
    case "28000":
      return "ANCHOR_OPERATOR_DATABASE_AUTHENTICATION_FAILED";
    case "3D000":
      return "ANCHOR_OPERATOR_DATABASE_TARGET_UNAVAILABLE";
    case "42501":
      return "ANCHOR_OPERATOR_DATABASE_PERMISSION_DENIED";
    case "ECONNREFUSED":
      return "ANCHOR_OPERATOR_DATABASE_CONNECTION_REFUSED";
    case "ETIMEDOUT":
      return "ANCHOR_OPERATOR_DATABASE_CONNECTION_TIMEOUT";
    case "EHOSTUNREACH":
    case "ENOTFOUND":
      return "ANCHOR_OPERATOR_DATABASE_CONNECTION_UNAVAILABLE";
    default:
      return null;
  }
}

function reject(code: string): never {
  throw new AnchorOperatorDatabaseError(code);
}

export function validateAnchorOperatorUrl(value: unknown, role: string): string {
  if (typeof value !== "string" || value.length > 2048) reject("ANCHOR_OPERATOR_URL_REJECTED");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return reject("ANCHOR_OPERATOR_URL_REJECTED");
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
      url.username !== role || url.password.length === 0 || url.password.length > 256 ||
      url.password.includes("\u0000") || url.hostname !== "127.0.0.1" ||
      url.port !== "55432" || url.pathname !== `/${ANCHOR_OPERATOR_DATABASE}` ||
      url.search !== "" || url.hash !== "") {
    reject("ANCHOR_OPERATOR_URL_REJECTED");
  }
  return value;
}

const forbiddenEnvironmentVariables = new Set([
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
  "PGSSLMODE",
  "PGOPTIONS",
  "NEON_DATABASE_URL",
]);

function assertCleanEnvironment(source: NodeJS.ProcessEnv, allowed: ReadonlySet<string>): void {
  if (Object.keys(source).some((name) =>
    (forbiddenEnvironmentVariables.has(name) && !allowed.has(name)) ||
    name.startsWith("PG") ||
    name.startsWith("NEON_") ||
    name.startsWith("PRISMA_") ||
    (name.startsWith("SIGAE_") && !allowed.has(name)) ||
    name === "NODE_OPTIONS" ||
    name === "NODE_PATH")) {
    reject("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
  }
}

export function validateAnchorOperatorRuntimeEnvironment(source: NodeJS.ProcessEnv): string {
  const allowed = new Set([
    ANCHOR_OPERATOR_URL_ENV,
    "SIGAE_M5_ANCHOR_OPERATOR_LAB",
    "SIGAE_M5_ANCHOR_OPERATOR_LAB_ID",
    "SIGAE_M1_ALLOWED_OPERATOR",
    "SESSION_SECRET",
    "TOTP_ENCRYPTION_KEY",
  ]);
  assertCleanEnvironment(source, allowed);
  if (source["SIGAE_M5_ANCHOR_OPERATOR_LAB"] !== "true" ||
      source["SIGAE_M5_ANCHOR_OPERATOR_LAB_ID"] !== ANCHOR_OPERATOR_LAB_ID) {
    reject("ANCHOR_OPERATOR_LAB_OPT_IN_REQUIRED");
  }
  return validateAnchorOperatorUrl(source[ANCHOR_OPERATOR_URL_ENV], ANCHOR_OPERATOR_RUNTIME_ROLE);
}

export function validateAnchorOperatorMigrationEnvironment(source: NodeJS.ProcessEnv): string {
  const allowed = new Set([
    ANCHOR_OPERATOR_MIGRATOR_URL_ENV,
    ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV,
  ]);
  assertCleanEnvironment(source, allowed);
  if (source[ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV] !== ANCHOR_OPERATOR_MIGRATIONS_OPT_IN) {
    reject("ANCHOR_OPERATOR_MIGRATION_OPT_IN_REQUIRED");
  }
  return validateAnchorOperatorUrl(
    source[ANCHOR_OPERATOR_MIGRATOR_URL_ENV],
    ANCHOR_OPERATOR_MIGRATOR_ROLE,
  );
}

export function validateAnchorOperatorMigrationPreflightEnvironment(
  source: NodeJS.ProcessEnv,
): string {
  const allowed = new Set([
    ANCHOR_OPERATOR_MIGRATOR_URL_ENV,
    ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_ENV,
  ]);
  assertCleanEnvironment(source, allowed);
  if (source[ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_ENV] !==
      ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_OPT_IN) {
    reject("ANCHOR_OPERATOR_READ_ONLY_PREFLIGHT_OPT_IN_REQUIRED");
  }
  return validateAnchorOperatorUrl(
    source[ANCHOR_OPERATOR_MIGRATOR_URL_ENV],
    ANCHOR_OPERATOR_MIGRATOR_ROLE,
  );
}

export function validateAnchorOperatorM1Environment(source: NodeJS.ProcessEnv): string {
  const allowed = new Set([
    "DATABASE_URL",
    "DIRECT_URL",
    "SIGAE_M5_ANCHOR_OPERATOR_LAB",
    "SIGAE_M5_ANCHOR_OPERATOR_LAB_ID",
    "SIGAE_M1_ALLOWED_OPERATOR",
    "TOTP_ENCRYPTION_KEY",
  ]);
  assertCleanEnvironment(source, allowed);
  if (source["SIGAE_M5_ANCHOR_OPERATOR_LAB"] !== "true" ||
      source["SIGAE_M5_ANCHOR_OPERATOR_LAB_ID"] !== ANCHOR_OPERATOR_LAB_ID ||
      source["SIGAE_M1_LAB"] !== undefined ||
      !source["DATABASE_URL"] || source["DIRECT_URL"] !== source["DATABASE_URL"]) {
    reject("ANCHOR_OPERATOR_M1_LAB_OPT_IN_REQUIRED");
  }
  return validateAnchorOperatorUrl(source["DATABASE_URL"], ANCHOR_OPERATOR_RUNTIME_ROLE);
}

export interface AnchorOperatorDatabaseIdentity {
  readonly databaseName: string;
  readonly username: string;
  readonly sessionUsername: string;
  readonly address: string | null;
  readonly port: number | null;
  readonly databaseOwner: string;
  readonly databaseMarker: string | null;
  readonly roleCanLogin: boolean;
  readonly roleSuperuser: boolean;
  readonly roleCreateDatabase: boolean;
  readonly roleCreateRole: boolean;
  readonly roleCanReplicate: boolean;
  readonly roleBypassRls: boolean;
  readonly roleHasMemberships: boolean;
  readonly publicSchemaExists: boolean;
  readonly publicSchemaCreate: boolean;
}

export function assertAnchorOperatorDatabaseIdentity(
  row: AnchorOperatorDatabaseIdentity,
  expectedRole: typeof ANCHOR_OPERATOR_RUNTIME_ROLE | typeof ANCHOR_OPERATOR_MIGRATOR_ROLE,
): void {
  if (row.databaseName !== ANCHOR_OPERATOR_DATABASE ||
      row.username !== expectedRole || row.sessionUsername !== expectedRole ||
      row.address !== "127.0.0.1" || row.port !== 55432 ||
      row.databaseOwner !== ANCHOR_OPERATOR_MIGRATOR_ROLE ||
      row.databaseMarker !== ANCHOR_OPERATOR_LAB_ID ||
      !row.roleCanLogin || row.roleSuperuser || row.roleCreateDatabase ||
      row.roleCreateRole || row.roleCanReplicate || row.roleBypassRls ||
      row.roleHasMemberships || !row.publicSchemaExists ||
      row.publicSchemaCreate !== (expectedRole === ANCHOR_OPERATOR_MIGRATOR_ROLE)) {
    reject("ANCHOR_OPERATOR_DATABASE_IDENTITY_REJECTED");
  }
}

export function assertAnchorOperatorEmptySchema(value: {
  readonly relationCount: number;
  readonly functionCount: number;
  readonly typeCount: number;
  readonly extraSchemaCount: number;
  readonly migrationLedgerMissing: boolean;
}): void {
  if (value.relationCount !== 0 || value.functionCount !== 0 ||
      value.typeCount !== 0 || value.extraSchemaCount !== 0 ||
      !value.migrationLedgerMissing) {
    reject("ANCHOR_OPERATOR_DATABASE_NOT_EMPTY");
  }
}
