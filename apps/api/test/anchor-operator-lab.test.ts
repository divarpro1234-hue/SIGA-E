import { Client } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  assertDatabaseIdentity,
  inspectReadiness,
  loadPersistedAlertEvidenceQueries,
  validateDeploymentEvidenceDate,
} from "../scripts/anchor-operator-lab.js";
import {
  ANCHOR_OPERATOR_DATABASE,
  ANCHOR_OPERATOR_LAB_ID,
  ANCHOR_OPERATOR_MIGRATOR_ROLE,
  ANCHOR_OPERATOR_RUNTIME_ROLE,
} from "../src/config/anchor-operator-database.js";

const expectedRuntimeTables = [
  "alerts",
  "alert_references",
  "approvals",
  "anchor_deployments",
  "anchor_jobs",
  "audit_chain_state",
  "audit_events",
  "identity_bootstrap",
  "identity_challenges",
  "identity_invitations",
  "identity_rate_limits",
  "public_keys",
  "sessions",
  "users",
];

function createReadinessClient(tables = expectedRuntimeTables): {
  readonly client: Client;
  readonly query: ReturnType<typeof vi.fn>;
} {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("_prisma_migrations")) {
      throw new Error("Runtime role must not query migration history");
    }
    if (sql.includes("FROM pg_class c JOIN pg_namespace")) {
      return { rows: [...tables].sort().map((name) => ({ name })) };
    }
    if (sql.includes("AS \"activeAuthors\"")) {
      return {
        rows: [{
          activeAuthors: "1",
          activeApprovers: "1",
          alertCount: "0",
          jobCount: "0",
          keyCount: "0",
        }],
      };
    }
    if (sql.includes("FROM anchor_deployments ORDER BY generation")) {
      return { rows: [] };
    }
    throw new Error("Unexpected readiness query");
  });
  return { client: { query } as unknown as Client, query };
}

function databaseIdentity(databaseName = ANCHOR_OPERATOR_DATABASE) {
  return {
    databaseName,
    username: ANCHOR_OPERATOR_RUNTIME_ROLE,
    sessionUsername: ANCHOR_OPERATOR_RUNTIME_ROLE,
    address: "127.0.0.1",
    port: 55432,
    databaseOwner: ANCHOR_OPERATOR_MIGRATOR_ROLE,
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
  };
}

describe("fecha de deployment del laboratorio AnchorWorker", () => {
  it("requiere una fecha UTC exacta y la compara con el registro existente", () => {
    const evidence = "2026-09-15T12:34:56.000Z";
    const expected = new Date(evidence);

    expect(validateDeploymentEvidenceDate(evidence).toISOString()).toBe(evidence);
    expect(validateDeploymentEvidenceDate(evidence, expected).toISOString()).toBe(evidence);
    expect(() => validateDeploymentEvidenceDate("2026-09-15T12:34:56Z"))
      .toThrow("ANCHOR_OPERATOR_DEPLOYMENT_DATE_INVALID");
    expect(() => validateDeploymentEvidenceDate(evidence, new Date("2026-09-16T12:34:56.000Z")))
      .toThrow("ANCHOR_OPERATOR_DEPLOYMENT_DATE_MISMATCH");
  });
});

describe("preflight runtime del laboratorio AnchorWorker", () => {
  it("valida tablas y datos de preparación sin consultar _prisma_migrations", async () => {
    const { client, query } = createReadinessClient([
      ...expectedRuntimeTables,
      "_prisma_migrations",
    ]);

    await expect(inspectReadiness(client)).resolves.toMatchObject({
      activeAuthors: 1,
      activeApprovers: 1,
      alertCount: 0,
      jobCount: 0,
      keyCount: 0,
      deployment: null,
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls.every(([sql]) => !sql.includes("_prisma_migrations"))).toBe(true);
  });

  it("rechaza un esquema incompleto antes de leer los datos del laboratorio", async () => {
    const { client, query } = createReadinessClient(
      expectedRuntimeTables.filter((table) => table !== "anchor_jobs"),
    );

    await expect(inspectReadiness(client)).rejects.toThrow("ANCHOR_OPERATOR_SCHEMA_NOT_READY");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).not.toContain("_prisma_migrations");
  });

  it("rechaza una base distinta antes de consultar el esquema runtime", async () => {
    const query = vi.fn(async () => ({ rows: [databaseIdentity("sigae_m5_anchor_itest")] }));
    const client = { query } as unknown as Client;

    await expect(assertDatabaseIdentity(client)).rejects.toThrow(
      "ANCHOR_OPERATOR_DATABASE_IDENTITY_REJECTED",
    );
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("consultas de evidencia persistida", () => {
  it("ejecuta public_keys, approvals y anchor_jobs secuencialmente en el mismo cliente", async () => {
    let activeQueries = 0;
    let maxConcurrentQueries = 0;
    const queryOrder: string[] = [];
    const query = vi.fn(async (sql: string) => {
      activeQueries += 1;
      maxConcurrentQueries = Math.max(maxConcurrentQueries, activeQueries);
      queryOrder.push(sql.includes("FROM public_keys")
        ? "public_keys"
        : sql.includes("FROM approvals")
          ? "approvals"
          : "anchor_jobs");
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeQueries -= 1;
      return { rows: [] };
    });
    const client = { query } as unknown as Client;

    await loadPersistedAlertEvidenceQueries(client, "alert-id", "key-id");

    expect(maxConcurrentQueries).toBe(1);
    expect(queryOrder).toEqual(["public_keys", "approvals", "anchor_jobs"]);
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("FROM public_keys WHERE kid = $1"),
      ["key-id"],
    ]);
    expect(query.mock.calls[1]).toEqual([
      expect.stringContaining("WHERE alert_id = $1::uuid ORDER BY reviewed_at"),
      ["alert-id"],
    ]);
    expect(query.mock.calls[2]).toEqual([
      expect.stringContaining("FROM anchor_jobs WHERE alert_id = $1::uuid"),
      ["alert-id"],
    ]);
  });
});
