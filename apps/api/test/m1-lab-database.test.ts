import { describe, expect, it } from "vitest";

import { createConfiguredApp } from "../src/bootstrap.js";
import { M1LabDatabaseError, validateM1LabDatabase } from "../src/config/m1-lab-database.js";
import { loadEnvironment } from "../src/config/environment.js";
import type { createPrismaClient } from "../src/infrastructure/database/prisma-client.js";
import { ANCHOR_OPERATOR_LAB_ID } from "../src/config/anchor-operator-database.js";

const local = "postgresql://fixture_user:synthetic-password@127.0.0.1:55432/sigae_m1_test";
const base = { SIGAE_M1_LAB: "true", DATABASE_URL: local, DIRECT_URL: local };

describe("destino PostgreSQL del laboratorio M1 (sin conexión)", () => {
  it("acepta únicamente la URL completa local exacta", () => {
    expect(validateM1LabDatabase(base)).toBe(local);
    expect(loadEnvironment(base).m1Lab).toBe(true);
  });

  it.each([
    "sigae_m5_anchor_operator",
    "sigae_m5_anchor_migrator",
    "sigae_m5%5Fanchor%5Foperator",
  ])("rechaza el rol PostgreSQL M5 %s en el perfil HTTP M1", (role) => {
    const withM5Role = local.replace("fixture_user", role);
    expect(() => validateM1LabDatabase({
      ...base,
      DATABASE_URL: withM5Role,
      DIRECT_URL: withM5Role,
    })).toThrow(M1LabDatabaseError);
  });

  it("permite el perfil M1 alternativo solo para la base aislada M5 exacta", () => {
    const operatorUrl =
      "postgresql://sigae_m5_anchor_operator:Lab-password_123@127.0.0.1:55432/sigae_m5_anchor_operator";
    expect(validateM1LabDatabase({
      SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: ANCHOR_OPERATOR_LAB_ID,
      SIGAE_M1_ALLOWED_OPERATOR: "operator",
      TOTP_ENCRYPTION_KEY: "t".repeat(43),
      DATABASE_URL: operatorUrl,
      DIRECT_URL: operatorUrl,
    })).toBe(operatorUrl);
    expect(() => validateM1LabDatabase({
      SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: ANCHOR_OPERATOR_LAB_ID,
      SIGAE_M1_ALLOWED_OPERATOR: "operator",
      TOTP_ENCRYPTION_KEY: "t".repeat(43),
      DATABASE_URL: operatorUrl.replace("sigae_m5_anchor_operator", "sigae_m1_test"),
      DIRECT_URL: operatorUrl.replace("sigae_m5_anchor_operator", "sigae_m1_test"),
    })).toThrow(M1LabDatabaseError);
  });

  it("solo habilita diagnóstico M2 con la bandera explícita del laboratorio", () => {
    expect(loadEnvironment({ ...base }).m2Diagnostics).toBe(false);
    expect(loadEnvironment({ ...base, SIGAE_M2_DIAGNOSTICS: "true" }).m2Diagnostics).toBe(true);
    expect(loadEnvironment({ ...base, SIGAE_M2_DIAGNOSTICS: "false" }).m2Diagnostics).toBe(false);
  });

  it.each([
    ["Neon", local.replace("127.0.0.1", "ep-fictional.neon.tech")],
    ["puerto", local.replace("55432", "5432")],
    ["base", local.replace("sigae_m1_test", "sigae_m1_test_copy")],
    ["localhost", local.replace("127.0.0.1", "localhost")],
    ["parámetro", `${local}?host=ep-fictional.neon.tech`],
    ["fragmento", `${local}#host=ep-fictional.neon.tech`],
    ["autoridad ambigua", local.replace("127.0.0.1", "127.0.0.1@ep-fictional.neon.tech")],
  ])("rechaza %s", (_case, databaseUrl) => {
    expect(() => validateM1LabDatabase({ ...base, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }))
      .toThrow(M1LabDatabaseError);
  });

  it("rechaza ausencias y DIRECT_URL contradictoria", () => {
    expect(() => validateM1LabDatabase({ SIGAE_M1_LAB: "true" })).toThrow(M1LabDatabaseError);
    expect(() => validateM1LabDatabase({ ...base, DIRECT_URL: undefined })).toThrow(M1LabDatabaseError);
    expect(() => validateM1LabDatabase({ ...base, DIRECT_URL: local.replace("127.0.0.1", "ep-fictional.neon.tech") }))
      .toThrow(M1LabDatabaseError);
  });

  it("exige activación expresa y rechaza variables heredadas que alteran el destino", () => {
    expect(() => validateM1LabDatabase({ DATABASE_URL: local, DIRECT_URL: local })).toThrow(M1LabDatabaseError);
    expect(() => loadEnvironment({ ...base, SIGAE_M1_LAB: "false" })).toThrow();
    expect(() => validateM1LabDatabase({ ...base, PGHOST: "ep-fictional.neon.tech" })).toThrow(M1LabDatabaseError);
    expect(() => validateM1LabDatabase({ ...base, SIGAE_DEVELOPMENT_DIRECT_URL: local })).toThrow(M1LabDatabaseError);
    expect(() => validateM1LabDatabase({
      ...base,
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: ANCHOR_OPERATOR_LAB_ID,
    })).toThrow(M1LabDatabaseError);
  });

  it("falla antes de construir Prisma y las rutas administrativas", () => {
    let clients = 0;
    const factory = (() => { clients += 1; throw new Error("no debe construirse Prisma"); }) as typeof createPrismaClient;
    expect(() => createConfiguredApp({
      ...base,
      DIRECT_URL: local.replace("55432", "5432"),
      M1_WRITES_ENABLED: "true",
      SESSION_SECRET: "s".repeat(32),
      APP_ORIGIN: "https://sigae.example.invalid",
      TOTP_ENCRYPTION_KEY: "t".repeat(43),
    }, factory))
      .toThrow(M1LabDatabaseError);
    expect(clients).toBe(0);
  });

  it("mantiene saneados los errores", () => {
    const password = "secret-ficticio-no-imprimir";
    const invalid = local.replace("fixture_user:synthetic-password", `fixture_user:${password}`) + "?host=remote";
    try {
      validateM1LabDatabase({ ...base, DATABASE_URL: invalid, DIRECT_URL: invalid });
    } catch (error) {
      expect(String(error)).not.toContain(password);
      expect(String(error)).not.toContain(invalid);
    }
  });
});
