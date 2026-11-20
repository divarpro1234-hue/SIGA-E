import { describe, expect, it } from "vitest";
import {
  ANCHOR_OPERATOR_DATABASE,
  ANCHOR_OPERATOR_LAB_ID,
  ANCHOR_OPERATOR_RUNTIME_ROLE,
} from "../../src/config/anchor-operator-database.js";
import {
  DEFAULT_MAX_FEE_STROOPS,
  MANUAL_TESTNET_DEFAULT_MAX_FEE_STROOPS,
  MANUAL_TESTNET_MAX_FEE_STROOPS,
} from "../../src/modules/anchor/stellar-sdk-admin-submitter.js";
import {
  assertOperatorRuntimeDatabaseIdentity,
  formatFeeDiagnostic,
  isAuthorizedOperator,
  main,
  parseAnchorWorkerFeeBudget,
  resolveOperatorDatabaseUrl,
} from "../../scripts/anchor-worker-once.js";

const databaseUrl =
  "postgresql://sigae_m5_anchor_operator:lab-only-password@127.0.0.1:55432/sigae_m5_anchor_operator";
const runtimeEnvironment = {
  SIGAE_M5_ANCHOR_OPERATOR_URL: databaseUrl,
  SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
  SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: ANCHOR_OPERATOR_LAB_ID,
  SIGAE_M1_ALLOWED_OPERATOR: "local-operator",
};

const databaseIdentity = (overrides: Record<string, unknown> = {}) => ({
  databaseName: ANCHOR_OPERATOR_DATABASE,
  username: ANCHOR_OPERATOR_RUNTIME_ROLE,
  sessionUsername: ANCHOR_OPERATOR_RUNTIME_ROLE,
  address: "127.0.0.1",
  port: 55432,
  databaseOwner: "sigae_m5_anchor_migrator",
  databaseMarker: ANCHOR_OPERATOR_LAB_ID,
  roleCanLogin: true,
  roleSuperuser: false,
  roleCreateDatabase: false,
  roleCreateRole: false,
  roleCanReplicate: false,
  roleBypassRls: false,
  roleHasMemberships: false,
  publicSchemaExists: true,
  publicSchemaCreate: false,
  ...overrides,
});

describe("entrada explícita de AnchorWorker", () => {
  it("valida solo URL, rol runtime y perfil exactos, sin usar URLs predeterminadas", () => {
    expect(resolveOperatorDatabaseUrl(runtimeEnvironment)).toBe(databaseUrl);
    for (const otherDatabase of [
      "sigae_m5_anchor_itest",
      "sigae_m3_issue_itest",
      "sigae_m2_http_itest",
      "sigae_m1_test",
      "another_local_database",
    ]) {
      expect(() => resolveOperatorDatabaseUrl({
        ...runtimeEnvironment,
        SIGAE_M5_ANCHOR_OPERATOR_URL: databaseUrl.replace(ANCHOR_OPERATOR_DATABASE, otherDatabase),
      })).toThrow("ANCHOR_OPERATOR_URL_REJECTED");
    }
    for (const change of [
      ["127.0.0.1", "localhost"],
      ["127.0.0.1", "192.0.2.10"],
      ["55432", "5432"],
      ["sigae_m5_anchor_operator:", "another_role:"],
    ]) {
      expect(() => resolveOperatorDatabaseUrl({
        ...runtimeEnvironment,
        SIGAE_M5_ANCHOR_OPERATOR_URL: databaseUrl.replace(change[0]!, change[1]!),
      })).toThrow("ANCHOR_OPERATOR_URL_REJECTED");
    }
    expect(() => resolveOperatorDatabaseUrl({
      ...runtimeEnvironment,
      DATABASE_URL: databaseUrl,
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
    expect(() => resolveOperatorDatabaseUrl({
      ...runtimeEnvironment,
      DIRECT_URL: databaseUrl,
    })).toThrow("ANCHOR_OPERATOR_ENVIRONMENT_REJECTED");
    expect(() => resolveOperatorDatabaseUrl({
      ...runtimeEnvironment,
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: "wrong-marker",
    })).toThrow("ANCHOR_OPERATOR_LAB_OPT_IN_REQUIRED");
  });

  it("valida la identidad efectiva de PostgreSQL y el marcador antes de leer deployments", () => {
    expect(() => assertOperatorRuntimeDatabaseIdentity(databaseIdentity())).not.toThrow();
    for (const change of [
      { databaseName: "sigae_m5_anchor_itest" },
      { address: "192.0.2.10" },
      { port: 5432 },
      { username: "sigae_m5_anchor_migrator" },
      { databaseMarker: "wrong-marker" },
      { roleSuperuser: true },
      { roleHasMemberships: true },
      { publicSchemaCreate: true },
    ]) {
      expect(() => assertOperatorRuntimeDatabaseIdentity(databaseIdentity(change)))
        .toThrow("ANCHOR_OPERATOR_DATABASE_IDENTITY_REJECTED");
    }
  });

  it("requiere que el operador del sistema coincida con el autorizado", () => {
    expect(isAuthorizedOperator(runtimeEnvironment, "local-operator")).toBe(true);
    expect(isAuthorizedOperator(runtimeEnvironment, "other-operator")).toBe(false);
    expect(isAuthorizedOperator({}, "local-operator")).toBe(false);
  });

  it("mantiene 2.000 stroops general y permite hasta 3.000.000 solo al CLI Testnet manual", () => {
    expect(DEFAULT_MAX_FEE_STROOPS).toBe(2_000n);
    expect(MANUAL_TESTNET_DEFAULT_MAX_FEE_STROOPS).toBe(40_000n);
    expect(MANUAL_TESTNET_MAX_FEE_STROOPS).toBe(3_000_000n);
    expect(parseAnchorWorkerFeeBudget(["--execute-testnet-anchor-once"]))
      .toBe(MANUAL_TESTNET_DEFAULT_MAX_FEE_STROOPS);
    expect(parseAnchorWorkerFeeBudget([
      "--execute-testnet-anchor-once", "--max-testnet-fee-stroops", "3000000",
    ])).toBe(3_000_000n);
    expect(parseAnchorWorkerFeeBudget([
      "--execute-testnet-anchor-once", "--max-testnet-fee-stroops", "2614789",
    ])).toBe(2_614_789n);
  });

  it.each([
    ["negative", "-1"],
    ["fractional", "100.5"],
    ["zero", "0"],
    ["above cap", "3000001"],
    ["non-numeric", "abc"],
  ])("rechaza presupuesto %s", (_label, value) => {
    expect(parseAnchorWorkerFeeBudget([
      "--execute-testnet-anchor-once", "--max-testnet-fee-stroops", value,
    ])).toBeNull();
  });

  it("rechaza el presupuesto sin modo worker o con argumentos extra", () => {
    expect(parseAnchorWorkerFeeBudget(["--max-testnet-fee-stroops", "3000000"])).toBeNull();
    expect(parseAnchorWorkerFeeBudget([
      "--execute-testnet-anchor-once", "--max-testnet-fee-stroops", "3000000", "extra",
    ])).toBeNull();
    expect(parseAnchorWorkerFeeBudget([
      "--execute-testnet-write", "--max-testnet-fee-stroops", "3000000",
    ])).toBeNull();
  });

  it("expone diagnóstico de tarifa simulada, tarifa XDR y presupuesto antes de autorización", () => {
    expect(formatFeeDiagnostic({
      baseFeeStroops: "100",
      minResourceFeeStroops: "2614689",
      calculatedTotalFeeStroops: "2614789",
      assembledFeeStroops: "2614789",
      maxFeeStroops: "3000000",
      rule: "WITHIN_LIMIT",
    })).toContain("Tarifa simulada: base 100 recursos 2614689 total 2614789 stroops. Tarifa XDR: 2614789 stroops. Presupuesto: 3000000 stroops (WITHIN_LIMIT).");
  });

  it("no abre conexión ni firma si se importa en lugar de ejecutarse directamente", async () => {
    const output: string[] = [];
    let confirmationAsked = false;

    await expect(main(["--execute-testnet-anchor-once"], {
      inputIsTTY: true,
      outputIsTTY: true,
      isCI: false,
      output: (line) => output.push(line),
      approveExecution: async () => {
        confirmationAsked = true;
        return true;
      },
    })).resolves.toBe(2);
    expect(confirmationAsked).toBe(false);
    expect(output.join("\n")).toContain("proceso CLI directo");
  });

  it("sin modo de ejecución solo muestra uso", async () => {
    const output: string[] = [];

    await expect(main([], { output: (line) => output.push(line) })).resolves.toBe(2);
    expect(output.join("\n")).toContain("Uso:");
  });
});
