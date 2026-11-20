import { describe, expect, it } from "vitest";

import {
  EnvironmentConfigurationError,
  loadEnvironment,
} from "../src/config/environment.js";

describe("configuración tipada", () => {
  it("acepta una configuración PostgreSQL mínima sin conectar", () => {
    const environment = loadEnvironment({
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: "3100",
      DATABASE_URL: "postgresql://fixture_user:synthetic-password@127.0.0.1:5432/placeholder",
    });

    expect(environment).toMatchObject({
      nodeEnv: "test",
      host: "127.0.0.1",
      port: 3100,
      isProduction: false,
      m2Diagnostics: false,
    });
  });

  it("mantiene M3 deshabilitado salvo activación explícita", () => {
    expect(loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
    }).m3SigningEnabled).toBe(false);
    expect(loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
      SIGAE_M3_SIGNING_ENABLED: "true",
    }).m3SigningEnabled).toBe(true);
  });

  it("rechaza las variables heredadas de clave que no configuran un proveedor seguro", () => {
    for (const unsupportedField of ["JWS_PRIVATE_KEY_PATH", "JWS_KID"]) {
      expect(() => loadEnvironment({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
        [unsupportedField]: "ignored",
      })).toThrow(EnvironmentConfigurationError);
    }
  });

  it("rechaza configuración Stellar en el servidor HTTP", () => {
    for (const field of ["STELLAR_NETWORK", "STELLAR_RPC_URL", "STELLAR_CONTRACT_ID", "STELLAR_SECRET_SEED"]) {
      expect(() => loadEnvironment({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
        [field]: "fixture-no-utilizable",
      })).toThrow(EnvironmentConfigurationError);
    }
  });

  it("rechaza configuración inválida sin incluir valores sensibles", () => {
    const invalidValue = "valor-sensible-de-prueba";

    expect(() =>
      loadEnvironment({
        NODE_ENV: "production",
        DATABASE_URL: invalidValue,
      }),
    ).toThrow(EnvironmentConfigurationError);

    try {
      loadEnvironment({ NODE_ENV: "production", DATABASE_URL: invalidValue });
    } catch (error) {
      expect(String(error)).not.toContain(invalidValue);
    }
  });

  it("exige un origen HTTPS exacto para proteger CSRF y cookies", () => {
    expect(loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
      APP_ORIGIN: "https://127.0.0.1:5173",
    }).appOrigin).toBe("https://127.0.0.1:5173");

    for (const appOrigin of [
      "http://127.0.0.1:5173",
      "https://127.0.0.1:5173/",
      "https://127.0.0.1:5173/path",
    ]) {
      expect(() => loadEnvironment({
        NODE_ENV: "test",
        DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
        APP_ORIGIN: appOrigin,
      })).toThrow(EnvironmentConfigurationError);
    }
  });

  it("no permite activar escrituras HTTP M1 fuera del laboratorio aislado", () => {
    expect(() => loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
      M1_WRITES_ENABLED: "true",
    })).toThrow(EnvironmentConfigurationError);
  });

  it("acepta el perfil M1 de Render solo con producción, TLS y el servidor público", () => {
    const environment = loadEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://runtime:fixture@db.internal:5432/sigae?sslmode=require",
      SIGAE_M1_RENDER_ENABLED: "true",
      M1_WRITES_ENABLED: "true",
      APP_ORIGIN: "https://sigae.example.invalid",
      SESSION_SECRET: Buffer.alloc(48, 83).toString("base64url"),
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    });

    expect(environment).toMatchObject({
      host: "0.0.0.0",
      m1Render: true,
      m1WritesEnabled: true,
      isProduction: true,
      m3SigningEnabled: false,
    });
  });

  it("falla cerrada si el perfil Render omite TLS, M1 o el bind público", () => {
    const base = {
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://runtime:fixture@db.internal:5432/sigae?sslmode=require",
      SIGAE_M1_RENDER_ENABLED: "true",
      M1_WRITES_ENABLED: "true",
      APP_ORIGIN: "https://sigae.example.invalid",
      SESSION_SECRET: Buffer.alloc(48, 83).toString("base64url"),
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    };
    expect(() => loadEnvironment({ ...base, HOST: "127.0.0.1" })).toThrow(EnvironmentConfigurationError);
    expect(() => loadEnvironment({ ...base, DATABASE_URL: base.DATABASE_URL.replace("sslmode=require", "sslmode=disable") }))
      .toThrow(EnvironmentConfigurationError);
    expect(() => loadEnvironment({ ...base, SIGAE_M3_SIGNING_ENABLED: "true" })).toThrow(EnvironmentConfigurationError);
    expect(() => loadEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: base.DATABASE_URL,
    })).toThrow(EnvironmentConfigurationError);
    expect(() => loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: base.DATABASE_URL,
      SIGAE_M1_RENDER_ENABLED: "true",
    })).toThrow(EnvironmentConfigurationError);
  });

  it("mantiene la API del laboratorio M1 enlazada únicamente a loopback", () => {
    const databaseUrl = "postgresql://test:test@127.0.0.1:55432/sigae_m1_test";
    expect(() => loadEnvironment({
      SIGAE_M1_LAB: "true",
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      HOST: "0.0.0.0",
    })).toThrow(EnvironmentConfigurationError);
  });

  it("rechaza la base y las variables de operador M5 en el servidor HTTP", () => {
    expect(() => loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://sigae_m5_anchor_operator:test@127.0.0.1:55432/sigae_m5_anchor_operator",
    })).toThrow(EnvironmentConfigurationError);

    expect(() => loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
      SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
    })).toThrow(EnvironmentConfigurationError);

    expect(() => loadEnvironment({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
      SIGAE_M1_ALLOWED_OPERATOR: "operator",
    })).toThrow(EnvironmentConfigurationError);
  });

  it("rechaza cualquier activación CLI del primer ADMIN en el servidor HTTP", () => {
    expect(() => loadEnvironment({
      NODE_ENV: "production",
      DATABASE_URL: "postgresql://runtime:fixture@db.internal:5432/sigae?sslmode=require",
      SIGAE_M1_RENDER_ENABLED: "true",
      M1_WRITES_ENABLED: "true",
      APP_ORIGIN: "https://sigae.example.invalid",
      SESSION_SECRET: Buffer.alloc(48, 83).toString("base64url"),
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
      SIGAE_M1_ADMIN_BOOTSTRAP_ENABLED: "true",
    })).toThrow("variables de operador M5/M1-CLI");
  });
});
