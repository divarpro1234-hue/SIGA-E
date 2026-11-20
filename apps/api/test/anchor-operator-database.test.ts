import { describe, expect, it } from "vitest";
import {
  ANCHOR_OPERATOR_DATABASE,
  ANCHOR_OPERATOR_LAB_ID,
  ANCHOR_OPERATOR_MIGRATIONS_OPT_IN,
  ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV,
  ANCHOR_OPERATOR_MIGRATOR_ROLE,
  ANCHOR_OPERATOR_MIGRATOR_URL_ENV,
  ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_ENV,
  ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_OPT_IN,
  ANCHOR_OPERATOR_RUNTIME_ROLE,
  ANCHOR_OPERATOR_URL_ENV,
  assertAnchorOperatorDatabaseIdentity,
  assertAnchorOperatorEmptySchema,
  validateAnchorOperatorM1Environment,
  validateAnchorOperatorMigrationEnvironment,
  validateAnchorOperatorMigrationPreflightEnvironment,
  validateAnchorOperatorRuntimeEnvironment,
  validateAnchorOperatorUrl,
  sanitizeAnchorOperatorDatabaseErrorCode,
} from "../src/config/anchor-operator-database.js";

const runtimeUrl =
  "postgresql://sigae_m5_anchor_operator:Lab-password_123@127.0.0.1:55432/sigae_m5_anchor_operator";
const migratorUrl =
  "postgresql://sigae_m5_anchor_migrator:Migration-password_123@127.0.0.1:55432/sigae_m5_anchor_operator";

const runtimeEnvironment = {
  [ANCHOR_OPERATOR_URL_ENV]: runtimeUrl,
  SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
  SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: ANCHOR_OPERATOR_LAB_ID,
};

const migrationEnvironment = {
  [ANCHOR_OPERATOR_MIGRATOR_URL_ENV]: migratorUrl,
  [ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV]: ANCHOR_OPERATOR_MIGRATIONS_OPT_IN,
};

const identity = (role: string, publicSchemaCreate: boolean) => ({
  databaseName: ANCHOR_OPERATOR_DATABASE,
  username: role,
  sessionUsername: role,
  address: "127.0.0.1",
  port: 55432,
  databaseOwner: ANCHOR_OPERATOR_MIGRATOR_ROLE,
  databaseMarker: ANCHOR_OPERATOR_LAB_ID,
  roleCanLogin: true,
  roleSuperuser: false,
  roleCreateDatabase: false,
  roleCreateRole: false,
  roleCanReplicate: false,
  roleBypassRls: false,
  roleHasMemberships: false,
  publicSchemaExists: true,
  publicSchemaCreate,
});

describe("aislamiento del laboratorio AnchorWorker", () => {
  it("clasifica solo codigos PostgreSQL conocidos sin filtrar mensajes", () => {
    expect(sanitizeAnchorOperatorDatabaseErrorCode(
      Object.assign(new Error("password detail must not be shown"), { code: "28P01" }),
    )).toBe("ANCHOR_OPERATOR_DATABASE_AUTHENTICATION_FAILED");
    expect(sanitizeAnchorOperatorDatabaseErrorCode(
      Object.assign(new Error("connection detail must not be shown"), { code: "ECONNREFUSED" }),
    )).toBe("ANCHOR_OPERATOR_DATABASE_CONNECTION_REFUSED");
    expect(sanitizeAnchorOperatorDatabaseErrorCode(
      Object.assign(new Error("secret"), { code: "XX999" }),
    )).toBeNull();
    expect(sanitizeAnchorOperatorDatabaseErrorCode(new Error("secret"))).toBeNull();
  });

  it("acepta solo la URL loopback con rol y base exactos", () => {
    expect(validateAnchorOperatorUrl(runtimeUrl, ANCHOR_OPERATOR_RUNTIME_ROLE)).toBe(runtimeUrl);
    expect(validateAnchorOperatorUrl(migratorUrl, ANCHOR_OPERATOR_MIGRATOR_ROLE)).toBe(migratorUrl);
  });

  it.each([
    ["otra base", runtimeUrl.replace(ANCHOR_OPERATOR_DATABASE, "sigae_m5_anchor_itest")],
    ["host remoto", runtimeUrl.replace("127.0.0.1", "db.example.invalid")],
    ["host localhost alternativo", runtimeUrl.replace("127.0.0.1", "localhost")],
    ["puerto distinto", runtimeUrl.replace("55432", "5432")],
    ["rol migrador para runtime", migratorUrl],
    ["query de enrutamiento", `${runtimeUrl}?host=remote.invalid`],
    ["fragmento", `${runtimeUrl}#other-database`],
  ])("rechaza URL de %s", (_label, value) => {
    expect(() => validateAnchorOperatorUrl(value, ANCHOR_OPERATOR_RUNTIME_ROLE))
      .toThrow("ANCHOR_OPERATOR_URL_REJECTED");
  });

  it("no usa DATABASE_URL como fallback y exige el perfil y marcador explícitos", () => {
    expect(validateAnchorOperatorRuntimeEnvironment(runtimeEnvironment)).toBe(runtimeUrl);
    expect(validateAnchorOperatorRuntimeEnvironment({
      ...runtimeEnvironment,
      SESSION_SECRET: "s".repeat(32),
      TOTP_ENCRYPTION_KEY: "t".repeat(43),
    })).toBe(runtimeUrl);
    expect(() => validateAnchorOperatorRuntimeEnvironment({
      ...runtimeEnvironment,
      [ANCHOR_OPERATOR_URL_ENV]: undefined,
      DATABASE_URL: runtimeUrl,
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
    expect(() => validateAnchorOperatorRuntimeEnvironment({
      ...runtimeEnvironment,
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: "other",
    })).toThrow("ANCHOR_OPERATOR_LAB_OPT_IN_REQUIRED");
    expect(() => validateAnchorOperatorRuntimeEnvironment({
      ...runtimeEnvironment,
      PGHOST: "remote.invalid",
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
  });

  it("exige consentimiento separado para migrar con el rol migrador", () => {
    expect(validateAnchorOperatorMigrationEnvironment(migrationEnvironment)).toBe(migratorUrl);
    expect(() => validateAnchorOperatorMigrationEnvironment({
      ...migrationEnvironment,
      [ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV]: undefined,
    })).toThrow("ANCHOR_OPERATOR_MIGRATION_OPT_IN_REQUIRED");
    expect(() => validateAnchorOperatorMigrationEnvironment({
      ...migrationEnvironment,
      DATABASE_URL: runtimeUrl,
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
  });

  it("separa el consentimiento de preflight de solo lectura del permiso de migracion", () => {
    expect(validateAnchorOperatorMigrationPreflightEnvironment({
      [ANCHOR_OPERATOR_MIGRATOR_URL_ENV]: migratorUrl,
      [ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_ENV]: ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_OPT_IN,
    })).toBe(migratorUrl);
    expect(() => validateAnchorOperatorMigrationPreflightEnvironment({
      [ANCHOR_OPERATOR_MIGRATOR_URL_ENV]: migratorUrl,
      [ANCHOR_OPERATOR_MIGRATIONS_OPT_IN_ENV]: ANCHOR_OPERATOR_MIGRATIONS_OPT_IN,
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
    expect(() => validateAnchorOperatorMigrationPreflightEnvironment({
      [ANCHOR_OPERATOR_MIGRATOR_URL_ENV]: migratorUrl,
      [ANCHOR_OPERATOR_MIGRATION_PREFLIGHT_ENV]: "wrong",
    })).toThrow("ANCHOR_OPERATOR_READ_ONLY_PREFLIGHT_OPT_IN_REQUIRED");
  });

  it("habilita M1 CLI solo con perfil y URLs de operador exactas", () => {
    const source = {
      SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: ANCHOR_OPERATOR_LAB_ID,
      SIGAE_M1_ALLOWED_OPERATOR: "operator",
      TOTP_ENCRYPTION_KEY: "t".repeat(43),
      DATABASE_URL: runtimeUrl,
      DIRECT_URL: runtimeUrl,
    };
    expect(validateAnchorOperatorM1Environment(source)).toBe(runtimeUrl);
    expect(() => validateAnchorOperatorM1Environment({
      ...source,
      DATABASE_URL: runtimeUrl.replace(ANCHOR_OPERATOR_DATABASE, "sigae_m1_test"),
      DIRECT_URL: runtimeUrl.replace(ANCHOR_OPERATOR_DATABASE, "sigae_m1_test"),
    })).toThrow("ANCHOR_OPERATOR_URL_REJECTED");
    expect(() => validateAnchorOperatorM1Environment({
      ...source,
      SIGAE_M1_LAB: "true",
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
  });

  it("valida identidad real de runtime y migrador con privilegios distintos", () => {
    expect(() => assertAnchorOperatorDatabaseIdentity(
      identity(ANCHOR_OPERATOR_RUNTIME_ROLE, false), ANCHOR_OPERATOR_RUNTIME_ROLE,
    )).not.toThrow();
    expect(() => assertAnchorOperatorDatabaseIdentity(
      identity(ANCHOR_OPERATOR_MIGRATOR_ROLE, true), ANCHOR_OPERATOR_MIGRATOR_ROLE,
    )).not.toThrow();
    expect(() => assertAnchorOperatorDatabaseIdentity(
      { ...identity(ANCHOR_OPERATOR_RUNTIME_ROLE, false), roleSuperuser: true },
      ANCHOR_OPERATOR_RUNTIME_ROLE,
    )).toThrow("ANCHOR_OPERATOR_DATABASE_IDENTITY_REJECTED");
    expect(() => assertAnchorOperatorDatabaseIdentity(
      { ...identity(ANCHOR_OPERATOR_RUNTIME_ROLE, false), databaseName: "sigae_m5_anchor_itest" },
      ANCHOR_OPERATOR_RUNTIME_ROLE,
    )).toThrow("ANCHOR_OPERATOR_DATABASE_IDENTITY_REJECTED");
  });

  it("rechaza esquema ya inicializado o con objetos ajenos", () => {
    expect(() => assertAnchorOperatorEmptySchema({
      relationCount: 0,
      functionCount: 0,
      typeCount: 0,
      extraSchemaCount: 0,
      migrationLedgerMissing: true,
    })).not.toThrow();
    expect(() => assertAnchorOperatorEmptySchema({
      relationCount: 1,
      functionCount: 0,
      typeCount: 0,
      extraSchemaCount: 0,
      migrationLedgerMissing: false,
    })).toThrow("ANCHOR_OPERATOR_DATABASE_NOT_EMPTY");
  });
});
