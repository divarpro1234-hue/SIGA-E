export const M3_ISSUE_LAB_ID = "SIGAE_M3_POSTGRES_ISSUE_LAB_V1";

const denied = () => new M3IssueIntegrationDatabaseError();
const dedicatedUrl =
  /^postgres(?:ql)?:\/\/sigae_m3_itest:[A-Za-z0-9._~-]+@127\.0\.0\.1:55432\/sigae_m3_issue_itest(?![\s\S])/u;
const migrationUrl =
  /^postgres(?:ql)?:\/\/sigae_m3_migrator:[A-Za-z0-9._~-]+@127\.0\.0\.1:55432\/sigae_m3_issue_itest(?![\s\S])/u;

export class M3IssueIntegrationDatabaseError extends Error {
  override readonly name = "M3IssueIntegrationDatabaseError";

  constructor() {
    super("Configuración PostgreSQL del laboratorio M3 inválida.");
  }
}

export function validateM3IssueIntegrationDatabase(source: unknown): string {
  try {
    if (source === null || typeof source !== "object" || Array.isArray(source)) throw denied();
    const prototype: unknown = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) throw denied();
    const keys = Reflect.ownKeys(source);
    if (!keys.includes("SIGAE_M3_POSTGRES_URL") ||
        !keys.includes("SIGAE_M3_POSTGRES_LAB_ID") ||
        keys.some((key) => key !== "SIGAE_M3_POSTGRES_URL" &&
          key !== "SIGAE_M3_POSTGRES_DIRECT_URL" && key !== "SIGAE_M3_POSTGRES_LAB_ID")) {
      throw denied();
    }

    const database = Object.getOwnPropertyDescriptor(source, "SIGAE_M3_POSTGRES_URL");
    const direct = Object.getOwnPropertyDescriptor(source, "SIGAE_M3_POSTGRES_DIRECT_URL");
    const labId = Object.getOwnPropertyDescriptor(source, "SIGAE_M3_POSTGRES_LAB_ID");
    if (!database || !("value" in database) || typeof database.value !== "string" ||
        !dedicatedUrl.test(database.value) ||
        !labId || !("value" in labId) || labId.value !== M3_ISSUE_LAB_ID ||
        (keys.includes("SIGAE_M3_POSTGRES_DIRECT_URL") &&
          (!direct || !("value" in direct) || direct.value !== database.value))) {
      throw denied();
    }
    return database.value;
  } catch {
    throw denied();
  }
}

export function validateM3IssueMigrationDatabase(source: unknown): string {
  try {
    if (source === null || typeof source !== "object" || Array.isArray(source)) throw denied();
    const prototype: unknown = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) throw denied();
    const keys = Reflect.ownKeys(source);
    if (keys.length !== 2 ||
        !keys.includes("SIGAE_M3_MIGRATOR_URL") ||
        !keys.includes("SIGAE_M3_POSTGRES_LAB_ID")) {
      throw denied();
    }

    const database = Object.getOwnPropertyDescriptor(source, "SIGAE_M3_MIGRATOR_URL");
    const labId = Object.getOwnPropertyDescriptor(source, "SIGAE_M3_POSTGRES_LAB_ID");
    if (!database || !("value" in database) || typeof database.value !== "string" ||
        !migrationUrl.test(database.value) ||
        !labId || !("value" in labId) || labId.value !== M3_ISSUE_LAB_ID) {
      throw denied();
    }
    return database.value;
  } catch {
    throw denied();
  }
}

export interface M3IssueTargetEvidence {
  readonly databaseName: string;
  readonly username: string;
  readonly sessionUsername: string;
  readonly address: string | null;
  readonly port: number | null;
  readonly timezone: string;
  readonly labMarker: string | null;
  readonly isSuperuser: boolean;
  readonly canCreateDatabase: boolean;
  readonly canCreateRole: boolean;
  readonly canReplicate: boolean;
  readonly canBypassRls: boolean;
  readonly isDatabaseOwner: boolean;
  readonly canCreateInDatabase: boolean;
  readonly canUsePublicSchema: boolean;
  readonly canCreateInPublicSchema: boolean;
  readonly ownsPublicObjects: boolean;
  readonly hasRoleMembership: boolean;
}

type M3IssueTableName =
  | "users"
  | "sessions"
  | "alerts"
  | "alert_references"
  | "approvals"
  | "public_keys"
  | "anchor_deployments"
  | "anchor_jobs"
  | "audit_events"
  | "audit_chain_state"
  | "identity_invitations"
  | "identity_challenges"
  | "identity_bootstrap"
  | "identity_rate_limits"
  | "_prisma_migrations";

type M3IssueTablePrivilege =
  | "SELECT"
  | "INSERT"
  | "UPDATE"
  | "DELETE"
  | "TRUNCATE"
  | "REFERENCES"
  | "TRIGGER"
  | "MAINTAIN";

export interface M3IssueTablePrivilegeEvidence {
  readonly tableName: string;
  readonly owner: string;
  readonly privilege: string;
  readonly granted: boolean;
}

const m3IssueTableNames: readonly M3IssueTableName[] = [
  "users",
  "sessions",
  "alerts",
  "alert_references",
  "approvals",
  "public_keys",
  "anchor_deployments",
  "anchor_jobs",
  "audit_events",
  "audit_chain_state",
  "identity_invitations",
  "identity_challenges",
  "identity_bootstrap",
  "identity_rate_limits",
  "_prisma_migrations",
];

const m3IssueTablePrivileges: readonly M3IssueTablePrivilege[] = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "MAINTAIN",
];

const expectedM3IssueRuntimePrivileges: Readonly<
  Record<M3IssueTableName, readonly M3IssueTablePrivilege[]>
> = {
  users: ["SELECT", "INSERT"],
  sessions: ["SELECT", "INSERT"],
  alerts: ["SELECT", "INSERT", "UPDATE"],
  alert_references: [],
  approvals: ["SELECT", "INSERT", "UPDATE"],
  public_keys: ["SELECT", "INSERT", "UPDATE"],
  anchor_deployments: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  anchor_jobs: ["SELECT", "INSERT"],
  audit_events: ["SELECT", "INSERT"],
  audit_chain_state: ["SELECT", "UPDATE"],
  identity_invitations: [],
  identity_challenges: [],
  identity_bootstrap: [],
  identity_rate_limits: [],
  _prisma_migrations: [],
};

function isM3IssueTableName(value: string): value is M3IssueTableName {
  return m3IssueTableNames.some((tableName) => tableName === value);
}

function isM3IssueTablePrivilege(value: string): value is M3IssueTablePrivilege {
  return m3IssueTablePrivileges.some((privilege) => privilege === value);
}

export function hasM3IssueTablePrivilegeState(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !==
      m3IssueTableNames.length * m3IssueTablePrivileges.length) return false;

  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const row = candidate as Partial<M3IssueTablePrivilegeEvidence>;
    if (typeof row.tableName !== "string" || !isM3IssueTableName(row.tableName) ||
        typeof row.owner !== "string" || typeof row.privilege !== "string" ||
        !isM3IssueTablePrivilege(row.privilege) || typeof row.granted !== "boolean") {
      return false;
    }

    const key = `${row.tableName}\0${row.privilege}`;
    if (seen.has(key) || row.owner !== "sigae_m3_migrator") return false;
    seen.add(key);
    const expected = expectedM3IssueRuntimePrivileges[row.tableName].includes(row.privilege);
    if (row.granted !== expected) return false;
  }

  return seen.size === m3IssueTableNames.length * m3IssueTablePrivileges.length;
}

export function isM3IssueTarget(value: unknown): value is M3IssueTargetEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Partial<M3IssueTargetEvidence>;
  return row.databaseName === "sigae_m3_issue_itest" &&
    row.username === "sigae_m3_itest" &&
    row.sessionUsername === row.username &&
    row.address === "127.0.0.1" &&
    row.port === 55432 &&
    row.timezone === "UTC" &&
    row.labMarker === M3_ISSUE_LAB_ID &&
    row.isSuperuser === false &&
    row.canCreateDatabase === false &&
    row.canCreateRole === false &&
    row.canReplicate === false &&
    row.canBypassRls === false &&
    row.isDatabaseOwner === false &&
    row.canCreateInDatabase === false &&
    row.canUsePublicSchema === true &&
    row.canCreateInPublicSchema === false &&
    row.ownsPublicObjects === false &&
    row.hasRoleMembership === false;
}
