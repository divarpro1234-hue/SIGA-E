import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  readFileSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertLocalSoloLabOnlyM4Config,
  m4LocalSoloApplicationTables,
  localSoloLabOperations,
  m4LocalSoloRequiredMigrations,
  readLocalSoloLabPreflightReport,
  readLocalSoloLabAuthorization,
  type LocalSoloLabOperation,
} from "../../scripts/m4-local-solo-authorization.js";
import { resolveM4AdminDatabaseUrl } from "../../scripts/m4-postgres-admin-preflight.js";

const temporaryDirectories: string[] = [];

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function createAuthorizationFiles(options: {
  readonly port?: number;
  readonly createdAt?: string;
  readonly expiresAt?: string;
  readonly authorizedOperations?: readonly LocalSoloLabOperation[];
} = {}): NodeJS.ProcessEnv {
  const directory = mkdtempSync(join(tmpdir(), "sigae-m4-local-solo-"));
  temporaryDirectories.push(directory);
  const capturedAt = new Date().toISOString();
  const dataDirectory = "D:\\Desarrollo\\SIGAE-M4-POSTGRES-LAB\\pgdata";
  const evidencePath = join(directory, "physical-evidence.json");
  const evidence = {
    evidenceStatus: "PHYSICAL_EVIDENCE_VERIFIED",
    capturedAtUtc: capturedAt,
    target: {
      host: "127.0.0.1",
      port: 65535,
      databaseName: "sigae_m4_test_20261113_01",
      systemIdentifier: "7707660153733072384",
      dataDirectory,
      adminRoleName: "sigae_m4_admin_20261113_01",
      runnerRoleName: "sigae_m4_test_20261113_01",
      postgresMajor: 17,
    },
    m4Listener: {
      count: 1,
      processId: 9628,
      executable: "D:\\Programas\\PostgreSQL\\17\\bin\\postgres.exe",
      listening: ["127.0.0.1:65535"],
      dataDirectoryArguments: [dataDirectory],
      exactlyOneExpectedDataDirectory: true,
    },
    pgControlData: {
      executable: "D:\\Programas\\PostgreSQL\\17\\bin\\pg_controldata.exe",
      version: "pg_controldata (PostgreSQL) 17.11",
      dataDirectory,
      systemIdentifier: "7707660153733072384",
      matchesExpected: true,
    },
    originalPostgres: {
      serviceName: "postgresql-x64-17",
      serviceState: "Running",
      serviceProcessId: 5084,
      serviceDataDirectoryArguments: ["D:\\Programas\\PostgreSQL\\17\\data"],
      listenerPids: [7476],
      independentOfM4: true,
    },
  };
  const evidenceBytes = Buffer.from(JSON.stringify(evidence), "utf8");
  writeFileSync(evidencePath, evidenceBytes);
  const createdAt = options.createdAt ?? capturedAt;
  const authorizationPath = join(directory, "local-solo-authorization.json");
  const authorization = {
    schemaVersion: 1,
    mode: "LOCAL_SOLO_LAB",
    status: "OPERATOR_ACKNOWLEDGED",
    authorizationId: randomUUID(),
    operator: "TESTDOMAIN\\operator",
    independentReviewer: "NONE",
    scope: "ACADEMIC_LOCAL_LAB",
    createdAt,
    expiresAt: options.expiresAt ??
      new Date(Date.parse(createdAt) + 10 * 60 * 1000).toISOString(),
    cluster: {
      host: "127.0.0.1",
      port: options.port ?? 65535,
      databaseName: "sigae_m4_test_20261113_01",
      systemIdentifier: "7707660153733072384",
      dataDirectory: "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata",
      adminRoleName: "sigae_m4_admin_20261113_01",
      runnerRoleName: "sigae_m4_test_20261113_01",
      postgresMajor: 17,
    },
    physicalEvidence: {
      path: evidencePath,
      sha256: sha256(evidenceBytes),
      verifiedAtUtc: capturedAt,
      listenerProcessId: 9628,
      pgControlDataSystemIdentifier: "7707660153733072384",
    },
    authorizedOperations: options.authorizedOperations ?? localSoloLabOperations,
  };
  const authorizationBytes = Buffer.from(JSON.stringify(authorization), "utf8");
  writeFileSync(authorizationPath, authorizationBytes);

  return {
    NODE_ENV: "test",
    SIGAE_M4_PG_AUTHORIZATION_MODE: "LOCAL_SOLO_LAB",
    SIGAE_M4_PG_LOCAL_SOLO_ACK: "I_ACKNOWLEDGE_LOCAL_SOLO_LAB",
    SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH: authorizationPath,
    SIGAE_M4_PG_LOCAL_SOLO_AUTH_SHA256: sha256(authorizationBytes),
  };
}

function addMatchingPreflightReport(environment: NodeJS.ProcessEnv): void {
  const authorizationPath = environment["SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH"]!;
  const authorization = JSON.parse(readFileSync(authorizationPath, "utf8")) as {
    readonly authorizationId: string;
  };
  const tableRowCounts: Record<string, number> = {};
  for (const table of m4LocalSoloApplicationTables) {
    tableRowCounts[table] = table === "audit_chain_state" ? 1 : 0;
  }
  const report = {
    status: "PREFLIGHT_PASSED_LOCAL_SOLO_LAB_NOT_INDEPENDENTLY_REVIEWED",
    authorizationMode: "LOCAL_SOLO_LAB",
    authorizationStatus: "OPERATOR_ACKNOWLEDGED",
    authorizationId: authorization.authorizationId,
    independentReviewer: "NONE",
    databaseName: "sigae_m4_test_20261113_01",
    adminRoleName: "sigae_m4_admin_20261113_01",
    runnerRoleName: "sigae_m4_test_20261113_01",
    host: "127.0.0.1",
    port: 65535,
    postgresMajor: 17,
    systemIdentifier: "7707660153733072384",
    dataDirectory: "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata",
    dataDirectorySource: "OPERATOR_ACKNOWLEDGED_PHYSICAL_EVIDENCE",
    verifiedMigrations: m4LocalSoloRequiredMigrations,
    runnerPrivilegesVerified: true,
    applicationTableNames: m4LocalSoloApplicationTables,
    tableRowCounts,
    unexpectedRelations: [],
    otherClientConnections: 0,
    auditChainGenesisVerified: true,
    checkedAt: new Date().toISOString(),
  };
  const reportPath = join(
    authorizationPath.replace(/[\\/][^\\/]+$/u, ""),
    "preflight-report.json",
  );
  const bytes = Buffer.from(JSON.stringify(report), "utf8");
  writeFileSync(reportPath, bytes);
  environment["SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_PATH"] = reportPath;
  environment["SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_SHA256"] = sha256(bytes);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("LOCAL_SOLO_LAB authorization", () => {
  it("accepts only the exact lab binding and an acknowledged operation", () => {
    const environment = createAuthorizationFiles();

    expect(readLocalSoloLabAuthorization(environment, "MIGRATE_DEPLOY")).toMatchObject({
      mode: "LOCAL_SOLO_LAB",
      status: "OPERATOR_ACKNOWLEDGED",
      independentReviewer: "NONE",
      databaseName: "sigae_m4_test_20261113_01",
      systemIdentifier: "7707660153733072384",
      dataDirectory: "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata",
      authorizedOperations: localSoloLabOperations,
    });
  });

  it("rejects a destination outside the fixed lab cluster", () => {
    const environment = createAuthorizationFiles({ port: 55432 });

    expect(() => readLocalSoloLabAuthorization(environment, "MIGRATE_DEPLOY"))
      .toThrow("M4_PG_LOCAL_SOLO_AUTH_INVALID");
  });

  it("rejects an expired operator acknowledgment", () => {
    const expiredAt = new Date(Date.now() - 11 * 60 * 1000);
    const environment = createAuthorizationFiles({
      createdAt: expiredAt.toISOString(),
      expiresAt: new Date(expiredAt.getTime() + 10 * 60 * 1000).toISOString(),
    });

    expect(() => readLocalSoloLabAuthorization(environment, "MIGRATE_DEPLOY"))
      .toThrow("M4_PG_LOCAL_SOLO_AUTH_EXPIRED");
  });

  it("rejects an operation not explicitly included in the acknowledgment", () => {
    const environment = createAuthorizationFiles({
      authorizedOperations: ["ADMIN_PREFLIGHT"],
    });

    expect(() => readLocalSoloLabAuthorization(environment, "MIGRATE_DEPLOY"))
      .toThrow("M4_PG_LOCAL_SOLO_OPERATION_NOT_AUTHORIZED");
  });

  it("rejects a changed authorization document", () => {
    const environment = createAuthorizationFiles();
    appendFileSync(environment["SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH"]!, " ");

    expect(() => readLocalSoloLabAuthorization(environment, "MIGRATE_DEPLOY"))
      .toThrow("M4_PG_LOCAL_SOLO_AUTH_HASH_MISMATCH");
  });

  it("rejects production mode and a missing manual acknowledgment", () => {
    const environment = createAuthorizationFiles();
    expect(() => readLocalSoloLabAuthorization(
      { ...environment, NODE_ENV: "production" },
      "MIGRATE_DEPLOY",
    )).toThrow("M4_PG_LOCAL_SOLO_PRODUCTION_REJECTED");
    expect(() => readLocalSoloLabAuthorization(
      { ...environment, SIGAE_M4_PG_LOCAL_SOLO_ACK: "" },
      "MIGRATE_DEPLOY",
    )).toThrow("M4_PG_LOCAL_SOLO_OPERATOR_ACK_REQUIRED");
  });

  it("prevents the standard Prisma config from accepting M4 authorization", () => {
    expect(() => assertLocalSoloLabOnlyM4Config({
      SIGAE_M4_PG_AUTHORIZATION_MODE: "LOCAL_SOLO_LAB",
    })).toThrow("M4_PG_AUTHORIZATION_REQUIRES_M4_CONFIG");
    expect(() => assertLocalSoloLabOnlyM4Config({})).not.toThrow();
  });

  it("binds Prisma M4 migration URLs to the authorized administrator and fixed target", () => {
    const environment = createAuthorizationFiles();
    const adminUrl =
      "postgresql://sigae_m4_admin_20261113_01:local-only@127.0.0.1:65535/sigae_m4_test_20261113_01";
    environment["DATABASE_URL"] = "postgresql://primary.invalid/primary";
    environment["DIRECT_URL"] = "postgresql://primary.invalid/primary-direct";
    environment["SIGAE_M4_PG_ADMIN_URL"] = adminUrl;

    expect(resolveM4AdminDatabaseUrl(environment)).toBe(adminUrl);

    expect(() => resolveM4AdminDatabaseUrl({
      ...environment,
      SIGAE_M4_PG_ADMIN_URL:
        "postgresql://sigae_m4_admin_20261113_01:local-only@remote.invalid:65535/sigae_m4_test_20261113_01",
    })).toThrow("M4_PG_ADMIN_DESTINATION_REJECTED");
  });

  it("requires a fresh, matching preflight report before the local harness", () => {
    const environment = createAuthorizationFiles();
    addMatchingPreflightReport(environment);
    const authorization = readLocalSoloLabAuthorization(
      environment,
      "RUN_POSTGRES_HARNESS",
    );

    expect(() => readLocalSoloLabPreflightReport(environment, authorization))
      .not.toThrow();

    const reportPath = environment["SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_PATH"]!;
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.otherClientConnections = 1;
    const bytes = Buffer.from(JSON.stringify(report), "utf8");
    writeFileSync(reportPath, bytes);
    environment["SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_SHA256"] = sha256(bytes);

    expect(() => readLocalSoloLabPreflightReport(environment, authorization))
      .toThrow("M4_PG_LOCAL_SOLO_PREFLIGHT_REJECTED");
  });
});
