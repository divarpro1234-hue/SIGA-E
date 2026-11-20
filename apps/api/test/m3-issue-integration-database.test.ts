import { describe, expect, it } from "vitest";
import {
  isM3IssueTarget,
  hasM3IssueTablePrivilegeState,
  M3_ISSUE_LAB_ID,
  M3IssueIntegrationDatabaseError,
  validateM3IssueIntegrationDatabase,
  validateM3IssueMigrationDatabase,
  type M3IssueTargetEvidence,
} from "../src/config/m3-issue-integration-database.js";

const url = "postgresql://sigae_m3_itest:Synthetic-password_123.~@127.0.0.1:55432/sigae_m3_issue_itest";
const configuration = {
  SIGAE_M3_POSTGRES_URL: url,
  SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID,
};
const allowedTablePrivileges: Readonly<Record<string, readonly string[]>> = {
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
const checkedTablePrivileges = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN",
];
const validPrivilegeEvidence = Object.entries(allowedTablePrivileges).flatMap(
  ([tableName, allowed]) => checkedTablePrivileges.map((privilege) => ({
    tableName,
    owner: "sigae_m3_migrator",
    privilege,
    granted: allowed.includes(privilege),
  })),
);
const migrationUrl = url.replace("sigae_m3_itest:", "sigae_m3_migrator:");
const validTarget: M3IssueTargetEvidence = {
  databaseName: "sigae_m3_issue_itest",
  username: "sigae_m3_itest",
  sessionUsername: "sigae_m3_itest",
  address: "127.0.0.1",
  port: 55432,
  timezone: "UTC",
  labMarker: M3_ISSUE_LAB_ID,
  isSuperuser: false,
  canCreateDatabase: false,
  canCreateRole: false,
  canReplicate: false,
  canBypassRls: false,
  isDatabaseOwner: false,
  canCreateInDatabase: false,
  canUsePublicSchema: true,
  canCreateInPublicSchema: false,
  ownsPublicObjects: false,
  hasRoleMembership: false,
};

describe("guard de destino M3 PostgreSQL (sin conexión)", () => {
  it("acepta solo el perfil dedicado con identificador explícito del laboratorio", () => {
    expect(validateM3IssueIntegrationDatabase(configuration)).toBe(url);
    expect(validateM3IssueIntegrationDatabase({
      ...configuration,
      SIGAE_M3_POSTGRES_DIRECT_URL: url,
    })).toBe(url);
  });

  it.each([
    ["base M2", url.replace("sigae_m3_issue_itest", "sigae_m2_submit_itest")],
    ["base de desarrollo", url.replace("sigae_m3_itest:", "postgres:")],
    ["base de producción", url.replace("127.0.0.1", "db.example.invalid")],
    ["puerto PostgreSQL estándar", url.replace("55432", "5432")],
    ["sin el identificador de laboratorio", undefined],
    ["identificador incorrecto", "SIGAE_M3_POSTGRES_ISSUE_LAB_V0"],
  ])("rechaza %s", (_description, value) => {
    const candidate = value === undefined
      ? { SIGAE_M3_POSTGRES_URL: url }
      : { ...configuration, SIGAE_M3_POSTGRES_LAB_ID: value };
    expect(() => validateM3IssueIntegrationDatabase(candidate))
      .toThrow(M3IssueIntegrationDatabaseError);
  });

  it("rechaza URL de desarrollo genérica, overrides y formas de URL ambiguas", () => {
    for (const candidate of [
      { ...configuration, DATABASE_URL: url },
      { ...configuration, DIRECT_URL: url },
      { ...configuration, SIGAE_M3_POSTGRES_DIRECT_URL: url.replace("55432", "5432") },
      { ...configuration, SIGAE_M3_POSTGRES_URL: `${url}?host=remote.invalid` },
      { ...configuration, SIGAE_M3_POSTGRES_URL: url.replace("127.0.0.1", "localhost") },
      { ...configuration, SIGAE_M3_POSTGRES_URL: url.replace("sigae_m3_itest:", "%73igae_m3_itest:") },
    ]) {
      expect(() => validateM3IssueIntegrationDatabase(candidate))
        .toThrow(M3IssueIntegrationDatabaseError);
    }
  });

  it("acepta migraciones solo con el rol separado y el marcador explícito", () => {
    expect(validateM3IssueMigrationDatabase({
      SIGAE_M3_MIGRATOR_URL: migrationUrl,
      SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID,
    })).toBe(migrationUrl);
  });

  it("rechaza destino de runtime, marcador ausente, overrides y URL ambigua al migrar", () => {
    for (const candidate of [
      { SIGAE_M3_MIGRATOR_URL: url, SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID },
      { SIGAE_M3_MIGRATOR_URL: migrationUrl },
      { SIGAE_M3_MIGRATOR_URL: migrationUrl, SIGAE_M3_POSTGRES_LAB_ID: "wrong" },
      { SIGAE_M3_MIGRATOR_URL: migrationUrl.replace("55432", "5432"), SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID },
      { SIGAE_M3_MIGRATOR_URL: `${migrationUrl}?host=remote.invalid`, SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID },
      { SIGAE_M3_MIGRATOR_URL: migrationUrl, SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID, DIRECT_URL: url },
    ]) {
      expect(() => validateM3IssueMigrationDatabase(candidate))
        .toThrow(M3IssueIntegrationDatabaseError);
    }
  });

  it("rechaza cualquier atributo de entorno adicional y no ejecuta accesores", () => {
    expect(() => validateM3IssueIntegrationDatabase({
      ...configuration,
      DATABASE_URL: url,
    })).toThrow(M3IssueIntegrationDatabaseError);
    let reads = 0;
    const accessor = {
      get SIGAE_M3_POSTGRES_URL() {
        reads += 1;
        return url;
      },
      SIGAE_M3_POSTGRES_LAB_ID: M3_ISSUE_LAB_ID,
    };
    expect(() => validateM3IssueIntegrationDatabase(accessor))
      .toThrow(M3IssueIntegrationDatabaseError);
    expect(reads).toBe(0);
  });

  it("no incluye credenciales en los errores", () => {
    const secret = "Synthetic-secret-never-echo";
    let caught: unknown;
    try {
      validateM3IssueIntegrationDatabase({
        ...configuration,
        SIGAE_M3_POSTGRES_URL: url.replace("Synthetic-password_123.~", secret),
        unexpected: true,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(M3IssueIntegrationDatabaseError);
    expect(String(caught)).not.toContain(secret);
    expect((caught as Error).stack).not.toContain(secret);
  });

  it("exige identidad de laboratorio y rol PostgreSQL sin privilegios destructivos", () => {
    expect(isM3IssueTarget(validTarget)).toBe(true);
    for (const key of [
      "databaseName", "username", "sessionUsername", "address", "port", "timezone", "labMarker",
      "isSuperuser", "canCreateDatabase", "canCreateRole", "canReplicate", "canBypassRls",
      "isDatabaseOwner", "canCreateInDatabase", "canUsePublicSchema", "canCreateInPublicSchema",
      "ownsPublicObjects", "hasRoleMembership",
    ] as const) {
      const current = validTarget[key];
      const replacement = typeof current === "boolean" ? !current : key === "port" ? 5432 : "invalid";
      const altered = { ...validTarget, [key]: replacement };
      expect(isM3IssueTarget(altered)).toBe(false);
    }
  });

  it("acepta únicamente los privilegios DML mínimos en tablas del laboratorio", () => {
    expect(hasM3IssueTablePrivilegeState(validPrivilegeEvidence)).toBe(true);

    const unexpectedDelete = validPrivilegeEvidence.map((row) =>
      row.tableName === "users" && row.privilege === "DELETE" ? { ...row, granted: true } : row);
    expect(hasM3IssueTablePrivilegeState(unexpectedDelete)).toBe(false);

    const migrationsAccess = validPrivilegeEvidence.map((row) =>
      row.tableName === "_prisma_migrations" && row.privilege === "SELECT"
        ? { ...row, granted: true }
        : row);
    expect(hasM3IssueTablePrivilegeState(migrationsAccess)).toBe(false);

    expect(hasM3IssueTablePrivilegeState(validPrivilegeEvidence.slice(1))).toBe(false);
    expect(hasM3IssueTablePrivilegeState([
      ...validPrivilegeEvidence,
      validPrivilegeEvidence[0],
    ])).toBe(false);
    expect(hasM3IssueTablePrivilegeState(validPrivilegeEvidence.map((row) =>
      row.tableName === "alerts" ? { ...row, owner: "sigae_m3_itest" } : row))).toBe(false);
  });
});
