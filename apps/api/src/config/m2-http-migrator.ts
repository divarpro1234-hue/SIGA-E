import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const M2_HTTP_MIGRATOR_DATABASE = "sigae_m2_http_itest";
export const M2_HTTP_MIGRATOR_ROLE = "sigae_m2_http_migrator";
export const M2_HTTP_MIGRATOR_URL_ENV = "SIGAE_M2_HTTP_MIGRATOR_DATABASE_URL";
export const M2_HTTP_MIGRATIONS_OPT_IN_ENV = "SIGAE_APPLY_M2_HTTP_MIGRATIONS";
export const M2_HTTP_MIGRATIONS_OPT_IN = "I_ACKNOWLEDGE_M2_HTTP_MIGRATIONS";

export const M2_HTTP_EXPECTED_MIGRATIONS = [
  "20261011_initial",
  "20261012_m1_identity_additive",
  "20261021_m2_approval_snapshot",
] as const;

const expectedMigrationHashes = new Map<string, string>([
  ["20261011_initial", "3a5d28d77dd23f9216a3c720c6eec065507a9a421c7473d5382345d02146765f"],
  ["20261012_m1_identity_additive", "68e63d15034859b56cfadcafc24e4626c811af67169a969bd5bd13c75e7b941f"],
  ["20261021_m2_approval_snapshot", "76ab6970e4a5eb716417e613d40d895301a141f373be68adaa7f83863915acba"],
]);

const expectedMigrationLockHash =
  "9959b6291d73ce91fffdb8ba5ff0a67f5bc76a7570cf0ee8f8de3c9a66c8177c";

const dedicatedUrlPattern =
  /^postgres(?:ql)?:\/\/sigae_m2_http_migrator:(?:[A-Za-z0-9._~-]|%[0-9A-Fa-f]{2})+@127\.0\.0\.1:55432\/sigae_m2_http_itest$/u;

const forbiddenConnectionVariables = new Set([
  "DATABASE_URL",
  "DIRECT_URL",
  "PRISMA_DATABASE_URL",
  "SIGAE_M2_HTTP_DATABASE_URL",
  "SIGAE_RUN_M2_HTTP_POSTGRES",
  "SIGAE_M2_LAB",
  "SIGAE_M1_LAB",
  "PGHOST",
  "PGPORT",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGSERVICE",
  "PGSERVICEFILE",
  "PGOPTIONS",
  "PGSSLMODE",
  "PGTARGETSESSIONATTRS",
]);

export class M2HttpMigratorConfigurationError extends Error {
  override readonly name = "M2HttpMigratorConfigurationError";
}

export function validateM2HttpMigratorUrl(value: unknown): string {
  if (typeof value !== "string" || !dedicatedUrlPattern.test(value)) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATOR_URL_REJECTED");
  }
  let parsed: URL;
  let password: string;
  try {
    parsed = new URL(value);
    password = decodeURIComponent(parsed.password);
  } catch {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATOR_URL_REJECTED");
  }
  if ((parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
      parsed.username !== M2_HTTP_MIGRATOR_ROLE ||
      parsed.hostname !== "127.0.0.1" ||
      parsed.port !== "55432" ||
      parsed.pathname !== `/${M2_HTTP_MIGRATOR_DATABASE}` ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      password.length === 0 ||
      password.length > 256 ||
      password.includes("\u0000")) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATOR_URL_REJECTED");
  }
  return value;
}

export function assertM2HttpMigratorEnvironment(source: NodeJS.ProcessEnv): string {
  const optIn = source[M2_HTTP_MIGRATIONS_OPT_IN_ENV];
  if (optIn !== M2_HTTP_MIGRATIONS_OPT_IN) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATIONS_OPERATOR_OPT_IN_REQUIRED");
  }
  if (Object.keys(source).some((name) =>
    forbiddenConnectionVariables.has(name) ||
    name.startsWith("PG") ||
    name.startsWith("PRISMA_") ||
    (name.startsWith("SIGAE_") &&
      name !== M2_HTTP_MIGRATOR_URL_ENV &&
      name !== M2_HTTP_MIGRATIONS_OPT_IN_ENV) ||
    name === "NODE_OPTIONS" ||
    name === "NODE_PATH")) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATOR_UNSAFE_ENVIRONMENT");
  }
  return validateM2HttpMigratorUrl(source[M2_HTTP_MIGRATOR_URL_ENV]);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function assertM2HttpMigrationFiles(apiRoot: string): Promise<void> {
  const migrationsPath = join(apiRoot, "prisma", "migrations");
  const entries = await readdir(migrationsPath, { withFileTypes: true });
  const directoryNames = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  if (JSON.stringify(directoryNames) !== JSON.stringify([...M2_HTTP_EXPECTED_MIGRATIONS].sort())) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATION_SET_REJECTED");
  }

  const nonDirectoryNames = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
  if (JSON.stringify(nonDirectoryNames) !== JSON.stringify(["migration_lock.toml"])) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATION_METADATA_REJECTED");
  }

  const lockBytes = await readFile(join(migrationsPath, "migration_lock.toml"));
  if (sha256(lockBytes) !== expectedMigrationLockHash) {
    throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATION_PROVIDER_LOCK_REJECTED");
  }

  for (const migrationName of M2_HTTP_EXPECTED_MIGRATIONS) {
    const migrationDirectory = join(migrationsPath, migrationName);
    const files = await readdir(migrationDirectory, { withFileTypes: true });
    const expectedFiles = migrationName === "20261012_m1_identity_additive"
      ? ["README.md", "migration.sql"]
      : ["migration.sql"];
    const actualFiles = files.map((file) => file.name).sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles) ||
        files.some((file) => !file.isFile())) {
      throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATION_CONTENT_SET_REJECTED");
    }
    const sqlBytes = await readFile(join(migrationDirectory, "migration.sql"));
    if (sha256(sqlBytes) !== expectedMigrationHashes.get(migrationName)) {
      throw new M2HttpMigratorConfigurationError("M2_HTTP_MIGRATION_CHECKSUM_REJECTED");
    }
  }
}
