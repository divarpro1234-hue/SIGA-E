import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

export const localSoloLabOperations = [
  "MIGRATE_DEPLOY",
  "GRANT_RUNNER_PRIVILEGES",
  "ADMIN_PREFLIGHT",
  "RUN_POSTGRES_HARNESS",
] as const;

export type LocalSoloLabOperation = (typeof localSoloLabOperations)[number];

export const m4LocalSoloRequiredMigrations = [
  "20261011_initial",
  "20261012_m1_identity_additive",
  "20261021_m2_approval_snapshot",
  "20261111_m5_pb3_retry_budget",
] as const;

export const m4LocalSoloApplicationTables = [
  "alerts",
  "alert_references",
  "anchor_deployments",
  "anchor_jobs",
  "approvals",
  "audit_chain_state",
  "audit_events",
  "identity_bootstrap",
  "identity_challenges",
  "identity_invitations",
  "identity_rate_limits",
  "public_keys",
  "sessions",
  "users",
] as const;

const expectedLab = {
  host: "127.0.0.1",
  port: 65_535,
  databaseName: "sigae_m4_test_20261113_01",
  systemIdentifier: "7707660153733072384",
  dataDirectory: "D:/Desarrollo/SIGAE-M4-POSTGRES-LAB/pgdata",
  adminRoleName: "sigae_m4_admin_20261113_01",
  runnerRoleName: "sigae_m4_test_20261113_01",
  postgresMajor: 17,
} as const;
const expectedOriginalDataDirectory = "D:/Programas/PostgreSQL/17/data";

const maximumAuthorizationAgeMs = 10 * 60 * 1000;
const maximumEvidenceAgeMs = 15 * 60 * 1000;
const maximumDocumentBytes = 16_384;
const repositoryRoot = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

export interface LocalSoloLabAuthorization {
  readonly mode: "LOCAL_SOLO_LAB";
  readonly status: "OPERATOR_ACKNOWLEDGED";
  readonly authorizationId: string;
  readonly operator: string;
  readonly independentReviewer: "NONE";
  readonly scope: "ACADEMIC_LOCAL_LAB";
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly authorizedOperations: readonly LocalSoloLabOperation[];
  readonly dataDirectory: string;
  readonly systemIdentifier: string;
  readonly databaseName: string;
  readonly host: "127.0.0.1";
  readonly port: 65_535;
  readonly adminRoleName: string;
  readonly runnerRoleName: string;
  readonly postgresMajor: 17;
}

export class LocalSoloLabAuthorizationError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options);
  }
}

function stop(code: string): never {
  throw new LocalSoloLabAuthorizationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function isLocalSoloLabOperation(value: unknown): value is LocalSoloLabOperation {
  return typeof value === "string" &&
    localSoloLabOperations.some((operation) => operation === value);
}

function isCanonicalDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function sameStrings(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value) &&
    value.length === expected.length &&
    expected.every((item, index) => value[index] === item);
}

function normalizedWindowsPath(value: string): string {
  return win32.normalize(value).replace(/[\\/]+$/u, "").toLowerCase();
}

function isExpectedDirectory(value: unknown): value is string {
  return typeof value === "string" &&
    win32.isAbsolute(value) &&
    normalizedWindowsPath(value) === normalizedWindowsPath(expectedLab.dataDirectory);
}

function pathIsWithinRepository(path: string): boolean {
  const pathFromRoot = relative(repositoryRoot, path);
  return pathFromRoot === "" ||
    (pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot));
}

function readExternalJson(
  pathValue: unknown,
  expectedHash: unknown,
  pathError: string,
  unavailableError: string,
  hashError: string,
  invalidError: string,
): { readonly path: string; readonly value: Record<string, unknown> } {
  if (typeof pathValue !== "string" || pathValue.length === 0 ||
      !isAbsolute(pathValue) ||
      typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/u.test(expectedHash)) {
    stop(pathError);
  }

  let actualPath: string;
  let bytes: Buffer;
  try {
    actualPath = realpathSync(pathValue);
    if (pathIsWithinRepository(actualPath) ||
        statSync(actualPath).size > maximumDocumentBytes) {
      stop(pathError);
    }
    bytes = readFileSync(actualPath);
  } catch (error) {
    if (error instanceof LocalSoloLabAuthorizationError) throw error;
    stop(unavailableError);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expectedHash) {
    stop(hashError);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    stop(invalidError);
  }
  if (!isRecord(parsed)) stop(invalidError);
  return { path: actualPath, value: parsed };
}

function validatePhysicalEvidence(
  evidence: Record<string, unknown>,
  expectedPath: string,
  expectedHash: string,
  expectedVerifiedAt: string,
): void {
  const evidenceFile = readExternalJson(
    expectedPath,
    expectedHash,
    "M4_PG_LOCAL_SOLO_EVIDENCE_PATH_REJECTED",
    "M4_PG_LOCAL_SOLO_EVIDENCE_UNAVAILABLE",
    "M4_PG_LOCAL_SOLO_EVIDENCE_HASH_MISMATCH",
    "M4_PG_LOCAL_SOLO_EVIDENCE_INVALID",
  ).value;
  const rootKeys = [
    "evidenceStatus",
    "capturedAtUtc",
    "target",
    "m4Listener",
    "pgControlData",
    "originalPostgres",
  ];
  if (!hasExactKeys(evidenceFile, rootKeys) ||
      evidenceFile["evidenceStatus"] !== "PHYSICAL_EVIDENCE_VERIFIED" ||
      evidenceFile["capturedAtUtc"] !== expectedVerifiedAt ||
      !isCanonicalDate(expectedVerifiedAt)) {
    stop("M4_PG_LOCAL_SOLO_EVIDENCE_INVALID");
  }

  const capturedAt = Date.parse(expectedVerifiedAt);
  const now = Date.now();
  if (capturedAt > now + 30_000 || now - capturedAt > maximumEvidenceAgeMs) {
    stop("M4_PG_LOCAL_SOLO_EVIDENCE_EXPIRED");
  }

  const target = evidenceFile["target"];
  const listener = evidenceFile["m4Listener"];
  const pgControlData = evidenceFile["pgControlData"];
  const originalPostgres = evidenceFile["originalPostgres"];
  if (!isRecord(target) || !isRecord(listener) ||
      !isRecord(pgControlData) || !isRecord(originalPostgres) ||
      !hasExactKeys(target, [
        "host",
        "port",
        "databaseName",
        "systemIdentifier",
        "dataDirectory",
        "adminRoleName",
        "runnerRoleName",
        "postgresMajor",
      ]) ||
      target["host"] !== expectedLab.host ||
      target["port"] !== expectedLab.port ||
      target["databaseName"] !== expectedLab.databaseName ||
      target["systemIdentifier"] !== expectedLab.systemIdentifier ||
      !isExpectedDirectory(target["dataDirectory"]) ||
      target["adminRoleName"] !== expectedLab.adminRoleName ||
      target["runnerRoleName"] !== expectedLab.runnerRoleName ||
      target["postgresMajor"] !== expectedLab.postgresMajor ||
      !hasExactKeys(listener, [
        "count",
        "processId",
        "executable",
        "listening",
        "dataDirectoryArguments",
        "exactlyOneExpectedDataDirectory",
      ]) ||
      listener["count"] !== 1 ||
      typeof listener["processId"] !== "number" ||
      !Number.isSafeInteger(listener["processId"]) ||
      listener["processId"] < 1 ||
      typeof listener["executable"] !== "string" ||
      !win32.isAbsolute(listener["executable"]) ||
      !/\\17\\bin\\postgres\.exe$/iu.test(listener["executable"]) ||
      !Array.isArray(listener["listening"]) ||
      listener["listening"].length !== 1 ||
      listener["listening"][0] !== "127.0.0.1:65535" ||
      !Array.isArray(listener["dataDirectoryArguments"]) ||
      listener["dataDirectoryArguments"].length !== 1 ||
      listener["dataDirectoryArguments"].filter(isExpectedDirectory).length !== 1 ||
      listener["exactlyOneExpectedDataDirectory"] !== true ||
      !hasExactKeys(pgControlData, [
        "executable",
        "version",
        "dataDirectory",
        "systemIdentifier",
        "matchesExpected",
      ]) ||
      typeof pgControlData["executable"] !== "string" ||
      !win32.isAbsolute(pgControlData["executable"]) ||
      !/\\17\\bin\\pg_controldata\.exe$/iu.test(pgControlData["executable"]) ||
      typeof pgControlData["version"] !== "string" ||
      !/^pg_controldata \(PostgreSQL\) 17\./iu.test(pgControlData["version"]) ||
      !isExpectedDirectory(pgControlData["dataDirectory"]) ||
      pgControlData["systemIdentifier"] !== expectedLab.systemIdentifier ||
      pgControlData["matchesExpected"] !== true ||
      !hasExactKeys(originalPostgres, [
        "serviceName",
        "serviceState",
        "serviceProcessId",
        "serviceDataDirectoryArguments",
        "listenerPids",
        "independentOfM4",
      ]) ||
      originalPostgres["serviceName"] !== "postgresql-x64-17" ||
      originalPostgres["serviceState"] !== "Running" ||
      typeof originalPostgres["serviceProcessId"] !== "number" ||
      !Number.isSafeInteger(originalPostgres["serviceProcessId"]) ||
      originalPostgres["serviceProcessId"] < 1 ||
      originalPostgres["serviceProcessId"] === listener["processId"] ||
      !Array.isArray(originalPostgres["serviceDataDirectoryArguments"]) ||
      originalPostgres["serviceDataDirectoryArguments"].length !== 1 ||
      !originalPostgres["serviceDataDirectoryArguments"].some((value) =>
        typeof value === "string" &&
        normalizedWindowsPath(value) ===
          normalizedWindowsPath(expectedOriginalDataDirectory)) ||
      originalPostgres["serviceDataDirectoryArguments"].some(isExpectedDirectory) ||
      !Array.isArray(originalPostgres["listenerPids"]) ||
      originalPostgres["listenerPids"].length === 0 ||
      !originalPostgres["listenerPids"].every((pid) =>
        typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) ||
      originalPostgres["listenerPids"].includes(listener["processId"]) ||
      originalPostgres["independentOfM4"] !== true ||
      evidence["listenerProcessId"] !== listener["processId"] ||
      evidence["pgControlDataSystemIdentifier"] !== expectedLab.systemIdentifier) {
    stop("M4_PG_LOCAL_SOLO_EVIDENCE_REJECTED");
  }
}

export function isLocalSoloLabRequested(environment: NodeJS.ProcessEnv): boolean {
  const mode = environment["SIGAE_M4_PG_AUTHORIZATION_MODE"];
  const hasLocalReferences = [
    "SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH",
    "SIGAE_M4_PG_LOCAL_SOLO_AUTH_SHA256",
    "SIGAE_M4_PG_LOCAL_SOLO_ACK",
    "SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_PATH",
    "SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_SHA256",
  ].some((key) => environment[key] !== undefined);
  if (mode === undefined || mode === "") {
    if (hasLocalReferences) stop("M4_PG_LOCAL_SOLO_MODE_REQUIRED");
    return false;
  }
  if (mode !== "LOCAL_SOLO_LAB") stop("M4_PG_AUTHORIZATION_MODE_REJECTED");
  return true;
}

export function assertLocalSoloLabOnlyM4Config(
  environment: NodeJS.ProcessEnv,
): void {
  const mode = environment["SIGAE_M4_PG_AUTHORIZATION_MODE"];
  const hasLocalReferences = [
    "SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH",
    "SIGAE_M4_PG_LOCAL_SOLO_AUTH_SHA256",
    "SIGAE_M4_PG_LOCAL_SOLO_ACK",
    "SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_PATH",
    "SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_SHA256",
  ].some((key) => environment[key] !== undefined);
  if ((mode !== undefined && mode !== "") || hasLocalReferences) {
    stop("M4_PG_AUTHORIZATION_REQUIRES_M4_CONFIG");
  }
}

export function readLocalSoloLabAuthorization(
  environment: NodeJS.ProcessEnv,
  requiredOperation: LocalSoloLabOperation,
): LocalSoloLabAuthorization {
  if (environment["NODE_ENV"]?.trim().toLowerCase() === "production") {
    stop("M4_PG_LOCAL_SOLO_PRODUCTION_REJECTED");
  }
  if (environment["SIGAE_M4_PG_AUTHORIZATION_MODE"] !== "LOCAL_SOLO_LAB") {
    stop("M4_PG_LOCAL_SOLO_MODE_REQUIRED");
  }
  if (environment["SIGAE_M4_PG_LOCAL_SOLO_ACK"] !== "I_ACKNOWLEDGE_LOCAL_SOLO_LAB") {
    stop("M4_PG_LOCAL_SOLO_OPERATOR_ACK_REQUIRED");
  }

  const authorizationFile = readExternalJson(
    environment["SIGAE_M4_PG_LOCAL_SOLO_AUTH_PATH"],
    environment["SIGAE_M4_PG_LOCAL_SOLO_AUTH_SHA256"],
    "M4_PG_LOCAL_SOLO_AUTH_PATH_REJECTED",
    "M4_PG_LOCAL_SOLO_AUTH_UNAVAILABLE",
    "M4_PG_LOCAL_SOLO_AUTH_HASH_MISMATCH",
    "M4_PG_LOCAL_SOLO_AUTH_INVALID",
  );
  const document = authorizationFile.value;
  const documentKeys = [
    "schemaVersion",
    "mode",
    "status",
    "authorizationId",
    "operator",
    "independentReviewer",
    "scope",
    "createdAt",
    "expiresAt",
    "cluster",
    "physicalEvidence",
    "authorizedOperations",
  ];
  const cluster = document["cluster"];
  const physicalEvidence = document["physicalEvidence"];
  const operations = document["authorizedOperations"];
  if (!hasExactKeys(document, documentKeys) ||
      document["schemaVersion"] !== 1 ||
      document["mode"] !== "LOCAL_SOLO_LAB" ||
      document["status"] !== "OPERATOR_ACKNOWLEDGED" ||
      typeof document["authorizationId"] !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
        .test(document["authorizationId"]) ||
      typeof document["operator"] !== "string" ||
      document["operator"].trim().length === 0 ||
      document["operator"].length > 128 ||
      /[\r\n]/u.test(document["operator"]) ||
      document["independentReviewer"] !== "NONE" ||
      document["scope"] !== "ACADEMIC_LOCAL_LAB" ||
      !isCanonicalDate(document["createdAt"]) ||
      !isCanonicalDate(document["expiresAt"]) ||
      !isRecord(cluster) ||
      !hasExactKeys(cluster, [
        "host",
        "port",
        "databaseName",
        "systemIdentifier",
        "dataDirectory",
        "adminRoleName",
        "runnerRoleName",
        "postgresMajor",
      ]) ||
      cluster["host"] !== expectedLab.host ||
      cluster["port"] !== expectedLab.port ||
      cluster["databaseName"] !== expectedLab.databaseName ||
      cluster["systemIdentifier"] !== expectedLab.systemIdentifier ||
      !isExpectedDirectory(cluster["dataDirectory"]) ||
      cluster["adminRoleName"] !== expectedLab.adminRoleName ||
      cluster["runnerRoleName"] !== expectedLab.runnerRoleName ||
      cluster["postgresMajor"] !== expectedLab.postgresMajor ||
      !isRecord(physicalEvidence) ||
      !hasExactKeys(physicalEvidence, [
        "path",
        "sha256",
        "verifiedAtUtc",
        "listenerProcessId",
        "pgControlDataSystemIdentifier",
      ]) ||
      typeof physicalEvidence["path"] !== "string" ||
      typeof physicalEvidence["sha256"] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(physicalEvidence["sha256"]) ||
      !isCanonicalDate(physicalEvidence["verifiedAtUtc"]) ||
      typeof physicalEvidence["listenerProcessId"] !== "number" ||
      !Number.isSafeInteger(physicalEvidence["listenerProcessId"]) ||
      physicalEvidence["listenerProcessId"] < 1 ||
      physicalEvidence["pgControlDataSystemIdentifier"] !==
        expectedLab.systemIdentifier ||
      !Array.isArray(operations) ||
      operations.length === 0 ||
      new Set(operations).size !== operations.length ||
      !operations.every(isLocalSoloLabOperation)) {
    stop("M4_PG_LOCAL_SOLO_AUTH_INVALID");
  }

  const createdAt = Date.parse(document["createdAt"]);
  const expiresAt = Date.parse(document["expiresAt"]);
  const physicalEvidenceAt = Date.parse(physicalEvidence["verifiedAtUtc"]);
  const now = Date.now();
  if (createdAt > now + 30_000 || expiresAt <= now ||
      expiresAt <= createdAt ||
      expiresAt - createdAt > maximumAuthorizationAgeMs ||
      now - createdAt > maximumAuthorizationAgeMs ||
      physicalEvidenceAt > createdAt) {
    stop("M4_PG_LOCAL_SOLO_AUTH_EXPIRED");
  }
  if (!operations.includes(requiredOperation)) {
    stop("M4_PG_LOCAL_SOLO_OPERATION_NOT_AUTHORIZED");
  }

  validatePhysicalEvidence(
    physicalEvidence,
    physicalEvidence["path"],
    physicalEvidence["sha256"],
    physicalEvidence["verifiedAtUtc"],
  );

  return {
    mode: "LOCAL_SOLO_LAB",
    status: "OPERATOR_ACKNOWLEDGED",
    authorizationId: document["authorizationId"],
    operator: document["operator"],
    independentReviewer: "NONE",
    scope: "ACADEMIC_LOCAL_LAB",
    createdAt: document["createdAt"],
    expiresAt: document["expiresAt"],
    authorizedOperations: operations,
    ...expectedLab,
  };
}

export function readLocalSoloLabPreflightReport(
  environment: NodeJS.ProcessEnv,
  authorization: LocalSoloLabAuthorization,
): void {
  const report = readExternalJson(
    environment["SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_PATH"],
    environment["SIGAE_M4_PG_LOCAL_SOLO_PREFLIGHT_SHA256"],
    "M4_PG_LOCAL_SOLO_PREFLIGHT_PATH_REJECTED",
    "M4_PG_LOCAL_SOLO_PREFLIGHT_UNAVAILABLE",
    "M4_PG_LOCAL_SOLO_PREFLIGHT_HASH_MISMATCH",
    "M4_PG_LOCAL_SOLO_PREFLIGHT_INVALID",
  ).value;
  const reportKeys = [
    "status",
    "authorizationMode",
    "authorizationStatus",
    "authorizationId",
    "independentReviewer",
    "databaseName",
    "adminRoleName",
    "runnerRoleName",
    "host",
    "port",
    "postgresMajor",
    "systemIdentifier",
    "dataDirectory",
    "dataDirectorySource",
    "verifiedMigrations",
    "runnerPrivilegesVerified",
    "applicationTableNames",
    "tableRowCounts",
    "unexpectedRelations",
    "otherClientConnections",
    "auditChainGenesisVerified",
    "checkedAt",
  ];
  const counts = report["tableRowCounts"];
  if (!hasExactKeys(report, reportKeys) ||
      report["status"] !== "PREFLIGHT_PASSED_LOCAL_SOLO_LAB_NOT_INDEPENDENTLY_REVIEWED" ||
      report["authorizationMode"] !== authorization.mode ||
      report["authorizationStatus"] !== authorization.status ||
      report["authorizationId"] !== authorization.authorizationId ||
      report["independentReviewer"] !== "NONE" ||
      report["databaseName"] !== authorization.databaseName ||
      report["adminRoleName"] !== authorization.adminRoleName ||
      report["runnerRoleName"] !== authorization.runnerRoleName ||
      report["host"] !== authorization.host ||
      report["port"] !== authorization.port ||
      report["postgresMajor"] !== authorization.postgresMajor ||
      report["systemIdentifier"] !== authorization.systemIdentifier ||
      !isExpectedDirectory(report["dataDirectory"]) ||
      report["dataDirectorySource"] !== "OPERATOR_ACKNOWLEDGED_PHYSICAL_EVIDENCE" ||
      !sameStrings(report["verifiedMigrations"], m4LocalSoloRequiredMigrations) ||
      report["runnerPrivilegesVerified"] !== true ||
      !sameStrings(report["applicationTableNames"], m4LocalSoloApplicationTables) ||
      !isRecord(counts) ||
      !hasExactKeys(counts, m4LocalSoloApplicationTables) ||
      m4LocalSoloApplicationTables.some((table) =>
        counts[table] !== (table === "audit_chain_state" ? 1 : 0)) ||
      !Array.isArray(report["unexpectedRelations"]) ||
      report["unexpectedRelations"].length !== 0 ||
      report["otherClientConnections"] !== 0 ||
      report["auditChainGenesisVerified"] !== true ||
      !isCanonicalDate(report["checkedAt"])) {
    stop("M4_PG_LOCAL_SOLO_PREFLIGHT_REJECTED");
  }

  const checkedAt = Date.parse(report["checkedAt"]);
  const now = Date.now();
  if (checkedAt < Date.parse(authorization.createdAt) ||
      checkedAt > Date.parse(authorization.expiresAt) ||
      checkedAt > now + 30_000 ||
      now - checkedAt > maximumAuthorizationAgeMs) {
    stop("M4_PG_LOCAL_SOLO_PREFLIGHT_EXPIRED");
  }
}
