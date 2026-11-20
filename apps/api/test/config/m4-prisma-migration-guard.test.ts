import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { m4LocalSoloRequiredMigrations } from "../../scripts/m4-local-solo-authorization.js";
import { assertM4PrismaMigrationDirectory } from "../../scripts/m4-prisma-migration-guard.js";

const apiRoot = fileURLToPath(new URL("../../", import.meta.url));
const migrationsDirectory = join(apiRoot, "prisma", "migrations");

function createM4MigrationFixture(): string {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "sigae-m4-prisma-migrations-"));
  const fixtureDirectory = join(fixtureRoot, "prisma", "migrations");
  mkdirSync(fixtureDirectory, { recursive: true });
  copyFileSync(
    join(migrationsDirectory, "migration_lock.toml"),
    join(fixtureDirectory, "migration_lock.toml"),
  );
  for (const migrationName of m4LocalSoloRequiredMigrations) {
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

describe("guardia de migraciones Prisma M4", () => {
  it("acepta exactamente las cuatro migraciones autorizadas", () => {
    const fixtureRoot = createM4MigrationFixture();
    try {
      expect(() => assertM4PrismaMigrationDirectory(
        join(fixtureRoot, "prisma", "migrations"),
      )).not.toThrow();
      expect(() => assertM4PrismaMigrationDirectory(migrationsDirectory)).not.toThrow();

      mkdirSync(join(
        fixtureRoot,
        "prisma",
        "migrations",
        "20261112_unapproved_migration",
      ));
      expect(() => assertM4PrismaMigrationDirectory(
        join(fixtureRoot, "prisma", "migrations"),
      )).toThrow("M4_PRISMA_MIGRATION_SET_REJECTED");

      rmSync(join(fixtureRoot, "prisma", "migrations", "20261112_unapproved_migration"), {
        recursive: true,
      });
      rmSync(join(
        fixtureRoot,
        "prisma",
        "migrations",
        "20261111_m5_pb3_retry_budget",
      ), { recursive: true });
      expect(() => assertM4PrismaMigrationDirectory(
        join(fixtureRoot, "prisma", "migrations"),
      )).toThrow("M4_PRISMA_MIGRATION_SET_REJECTED");
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
});
