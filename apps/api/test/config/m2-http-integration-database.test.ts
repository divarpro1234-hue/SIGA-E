import { describe, expect, it } from "vitest";
import {
  M2_HTTP_WRITE_OPT_IN,
  M2HttpIntegrationDatabaseError,
  createM2HttpIntegrationDatabaseClient,
  validateM2HttpIntegrationDatabase,
} from "../../src/config/m2-http-integration-database.js";

const validUrl =
  "postgresql://sigae_m2_http_itest:UnitTest-Only_123@127.0.0.1:55432/sigae_m2_http_itest";

describe("guardia de configuración de integración HTTP M2", () => {
  it("acepta exclusivamente la URL dedicada con destino, usuario y puerto cerrados", () => {
    expect(validateM2HttpIntegrationDatabase({
      SIGAE_M2_HTTP_DATABASE_URL: validUrl,
    })).toBe(validUrl);
  });

  it.each([
    "postgresql://other:UnitTest-Only_123@127.0.0.1:55432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_itest:UnitTest-Only_123@localhost:55432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_itest:UnitTest-Only_123@127.0.0.1:5432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_itest:UnitTest-Only_123@127.0.0.1:55432/sigae_m3_issue_itest",
    `${validUrl}?sslmode=disable`,
    `${validUrl}#fragment`,
    `${validUrl}\n`,
  ])("rechaza URL fuera del allowlist: %s", (databaseUrl) => {
    expect(() => validateM2HttpIntegrationDatabase({
      SIGAE_M2_HTTP_DATABASE_URL: databaseUrl,
    })).toThrow(M2HttpIntegrationDatabaseError);
  });

  it("rechaza fuentes con variables de conexión adicionales", () => {
    expect(() => validateM2HttpIntegrationDatabase({
      SIGAE_M2_HTTP_DATABASE_URL: validUrl,
      DATABASE_URL: validUrl,
    })).toThrow("M2_HTTP_DATABASE_CONFIGURATION_REJECTED");
  });

  it("requiere opt-in antes de crear el cliente y bloquea variables genéricas", () => {
    expect(() => createM2HttpIntegrationDatabaseClient({
      SIGAE_M2_HTTP_DATABASE_URL: validUrl,
    })).toThrow("M2_HTTP_OPERATOR_OPT_IN_REQUIRED");

    expect(() => createM2HttpIntegrationDatabaseClient({
      SIGAE_M2_HTTP_DATABASE_URL: validUrl,
      SIGAE_RUN_M2_HTTP_POSTGRES: M2_HTTP_WRITE_OPT_IN,
      DATABASE_URL: validUrl,
    } as NodeJS.ProcessEnv)).toThrow("M2_HTTP_GENERIC_DATABASE_VARIABLE_REJECTED");
  });
});
