import { describe, expect, it } from "vitest";

import {
  M1ProductionAdminBootstrapError,
  readM1ProductionAdminBootstrapConfig,
  validateM1ProductionAdminBootstrapProfile,
} from "../src/config/m1-production-admin-bootstrap.js";

const now = new Date();
const databaseUrl = "postgresql://sigae_app:fixture-password@dpg-sigae-academic-a/sigae_academic?sslmode=require";
const base: NodeJS.ProcessEnv = {
  SIGAE_M1_ADMIN_BOOTSTRAP_ENABLED: "true",
  SIGAE_M1_ADMIN_BOOTSTRAP_EXPIRES_AT: new Date(now.getTime() + 10 * 60_000).toISOString(),
  SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_HOST: "dpg-sigae-academic-a",
  SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_NAME: "sigae_academic",
  SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_USER: "sigae_app",
  SIGAE_M1_ADMIN_BOOTSTRAP_TARGET_ID: "a7a5a392-e5ab-4c28-a7f3-1d4765150fc2",
  DATABASE_URL: databaseUrl,
  TOTP_ENCRYPTION_KEY: Buffer.alloc(32, 19).toString("base64url"),
};

function expectSafeFailure(source: NodeJS.ProcessEnv, nowOverride = now): void {
  try {
    readM1ProductionAdminBootstrapConfig(source, nowOverride);
    throw new Error("expected configuration rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(M1ProductionAdminBootstrapError);
    expect(String(error)).not.toContain("fixture-password");
    if (source["TOTP_ENCRYPTION_KEY"]) {
      expect(String(error)).not.toContain(source["TOTP_ENCRYPTION_KEY"]);
    }
  }
}

describe("bootstrap único de ADMIN en Render", () => {
  it("acepta solo una activación temporal y una URL cuyo host, base, rol y TLS coinciden", () => {
    const config = readM1ProductionAdminBootstrapConfig(base, now);
    expect(config).toMatchObject({
      databaseHost: "dpg-sigae-academic-a",
      databaseName: "sigae_academic",
      databaseUser: "sigae_app",
      targetId: "a7a5a392-e5ab-4c28-a7f3-1d4765150fc2",
      expiresAt: new Date(now.getTime() + 10 * 60_000),
    });
    expect(config.totpKey).toHaveLength(32);
    expect(() => validateM1ProductionAdminBootstrapProfile(base, now)).not.toThrow();
  });

  it("falla cerrado si no hay activación explícita, si expiró o si dura más de 15 minutos", () => {
    expectSafeFailure({ ...base, SIGAE_M1_ADMIN_BOOTSTRAP_ENABLED: undefined });
    expectSafeFailure({
      ...base,
      SIGAE_M1_ADMIN_BOOTSTRAP_EXPIRES_AT: new Date(now.getTime() - 1).toISOString(),
    });
    expectSafeFailure({
      ...base,
      SIGAE_M1_ADMIN_BOOTSTRAP_EXPIRES_AT: new Date(now.getTime() + 15 * 60_000 + 1).toISOString(),
    });
  });

  it("rechaza desvíos de host/base/rol/TLS, loopback, parámetros adicionales y TOTP inválido", () => {
    for (const invalid of [
      { SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_HOST: "other-render-host" },
      { SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_NAME: "other_database" },
      { SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_USER: "other_role" },
      { DATABASE_URL: databaseUrl.replace("sslmode=require", "sslmode=disable") },
      { DATABASE_URL: databaseUrl + "&connect_timeout=2" },
      { DATABASE_URL: "postgresql://sigae_app:fixture-password@127.0.0.1:55434/sigae_academic?sslmode=require",
        SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_HOST: "127.0.0.1" },
      { TOTP_ENCRYPTION_KEY: "not-a-canonical-key" },
    ]) expectSafeFailure({ ...base, ...invalid });
  });

  it("falla sin propagar detalles del URL ni material criptográfico", () => {
    expectSafeFailure({ ...base, DATABASE_URL: "not-a-database-url" });
  });
});
