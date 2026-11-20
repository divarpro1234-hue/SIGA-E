import { describe, expect, it } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertM2HttpMigrationFiles,
  assertM2HttpMigratorEnvironment,
  M2_HTTP_EXPECTED_MIGRATIONS,
  M2_HTTP_MIGRATIONS_OPT_IN,
  M2_HTTP_MIGRATIONS_OPT_IN_ENV,
  M2_HTTP_MIGRATOR_URL_ENV,
  M2HttpMigratorConfigurationError,
  validateM2HttpMigratorUrl,
} from "../../src/config/m2-http-migrator.js";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDirectory = join(apiRoot, "prisma", "migrations");
const validUrl =
  "postgresql://sigae_m2_http_migrator:fixture-password@127.0.0.1:55432/sigae_m2_http_itest";

function createAuthorizedMigrationFixture(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "sigae-m2-http-migrations-"));
  const fixtureDirectory = join(fixtureRoot, "prisma", "migrations");
  mkdirSync(fixtureDirectory, { recursive: true });
  copyFileSync(
    join(migrationsDirectory, "migration_lock.toml"),
    join(fixtureDirectory, "migration_lock.toml"),
  );
  for (const migrationName of M2_HTTP_EXPECTED_MIGRATIONS) {
    const sourceDirectory = join(migrationsDirectory, migrationName);
    const destinationDirectory = join(fixtureDirectory, migrationName);
    mkdirSync(destinationDirectory);
    const files = migrationName === "20261012_m1_identity_additive"
      ? ["README.md", "migration.sql"]
      : ["migration.sql"];
    for (const file of files) {
      copyFileSync(join(sourceDirectory, file), join(destinationDirectory, file));
    }
  }
  return fixtureRoot;
}

describe("guardia del ejecutor de migraciones M2 HTTP", () => {
  it("acepta solo la conexión literal del laboratorio y el rol migrador", () => {
    expect(validateM2HttpMigratorUrl(validUrl)).toBe(validUrl);
  });

  it.each([
    "postgresql://sigae_m2_http_itest:fixture-password@127.0.0.1:55432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_migrator:fixture-password@localhost:55432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_migrator:fixture-password@127.0.0.1:5432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_migrator:fixture-password@127.0.0.1:55432/sigae_m3_issue_itest",
    `${validUrl}?sslmode=disable`,
    `${validUrl}#fragment`,
    "postgresql://sigae_m2_http_migrator:fixture%@127.0.0.1:55432/sigae_m2_http_itest",
    "postgresql://sigae_m2_http_migrator:fixture%ZZ@127.0.0.1:55432/sigae_m2_http_itest",
  ])("rechaza URLs que no coinciden exactamente: %s", (databaseUrl) => {
    expect(() => validateM2HttpMigratorUrl(databaseUrl))
      .toThrow(M2HttpMigratorConfigurationError);
  });

  it("admite contraseñas URL-encoded sin alterar el destino configurado", () => {
    const url = "postgresql://sigae_m2_http_migrator:fixture%2Dpassword@127.0.0.1:55432/sigae_m2_http_itest";
    expect(validateM2HttpMigratorUrl(url)).toBe(url);
  });

  it("acepta solo las dos variables SIGAE autorizadas y exige opt-in", () => {
    expect(() => assertM2HttpMigratorEnvironment({
      [M2_HTTP_MIGRATOR_URL_ENV]: validUrl,
    } as NodeJS.ProcessEnv)).toThrow("M2_HTTP_MIGRATIONS_OPERATOR_OPT_IN_REQUIRED");

    const authorizedEnvironment = {
      [M2_HTTP_MIGRATOR_URL_ENV]: validUrl,
      [M2_HTTP_MIGRATIONS_OPT_IN_ENV]: M2_HTTP_MIGRATIONS_OPT_IN,
    } as NodeJS.ProcessEnv;
    expect(assertM2HttpMigratorEnvironment(authorizedEnvironment)).toBe(validUrl);

    for (const unsafeName of [
      "DIRECT_URL",
      "PRISMA_SCHEMA_ENGINE_BINARY",
      "PRISMA_OTHER",
      "SIGAE_M2_HTTP_DATABASE_URL",
      "SIGAE_OTHER",
      "PGHOST",
      "PGOTHER",
      "NODE_OPTIONS",
      "NODE_PATH",
    ]) {
      expect(() => assertM2HttpMigratorEnvironment({
        ...authorizedEnvironment,
        [unsafeName]: "not-printed",
      } as NodeJS.ProcessEnv), unsafeName).toThrow("M2_HTTP_MIGRATOR_UNSAFE_ENVIRONMENT");
    }
  });

  it("acepta el fixture exacto de tres migraciones y rechaza el arbol actual de cuatro", async () => {
    const fixtureRoot = createAuthorizedMigrationFixture();
    try {
      await expect(assertM2HttpMigrationFiles(fixtureRoot)).resolves.toBeUndefined();
      await expect(assertM2HttpMigrationFiles(apiRoot))
        .rejects.toThrow("M2_HTTP_MIGRATION_SET_REJECTED");

      mkdirSync(join(fixtureRoot, "prisma", "migrations", "20261111_m5_pb3_retry_budget"));
      await expect(assertM2HttpMigrationFiles(fixtureRoot))
        .rejects.toThrow("M2_HTTP_MIGRATION_SET_REJECTED");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
