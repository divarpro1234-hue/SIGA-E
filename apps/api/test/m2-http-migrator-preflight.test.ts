import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  assertM2HttpDatabaseIdentityResult,
  assertM2HttpGenesisResult,
  type M2HttpQueryResult,
  type M2HttpTargetIdentity,
} from "../scripts/migrate-m2-http.js";

function pgResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, rows, fields: [] };
}

function emptyAuthorizedDatabase(): M2HttpTargetIdentity {
  return {
    database: "sigae_m2_http_itest",
    username: "sigae_m2_http_migrator",
    address: "127.0.0.1",
    port: 55432,
    serverVersion: 170000,
    databaseOwner: "sigae_m2_http_migrator",
    databaseEncoding: "UTF8",
    databaseMarker: null,
    roleCanLogin: true,
    roleSuperuser: false,
    roleCreateDatabase: false,
    roleCreateRole: false,
    roleBypassRls: false,
    roleHasMemberships: false,
    publicSchemaExists: true,
    publicSchemaCreate: true,
    publicRelationCount: 0,
    publicFunctionCount: 0,
    publicTypeCount: 0,
    extraSchemaCount: 0,
    migrationLedgerMissing: true,
  };
}

describe("preflight y postflight M2 HTTP con respuestas de pg", () => {
  it("autoriza la base vacía con contadores integer numéricos", () => {
    const identity = emptyAuthorizedDatabase();

    expect(typeof identity.publicRelationCount).toBe("number");
    expect(typeof identity.extraSchemaCount).toBe("number");
    expect(assertM2HttpDatabaseIdentityResult(pgResult([identity]), true)).toEqual(identity);
  });

  it("rechaza una base con relaciones existentes", () => {
    const identity = { ...emptyAuthorizedDatabase(), publicRelationCount: 1 };

    expect(() => assertM2HttpDatabaseIdentityResult(pgResult([identity]), true))
      .toThrow("M2_HTTP_MIGRATION_TARGET_REJECTED");
  });

  it("rechaza un schema adicional", () => {
    const identity = { ...emptyAuthorizedDatabase(), extraSchemaCount: 1 };

    expect(() => assertM2HttpDatabaseIdentityResult(pgResult([identity]), true))
      .toThrow("M2_HTTP_MIGRATION_TARGET_REJECTED");
  });

  it("acepta la génesis con row_count integer numérico igual a uno", () => {
    const genesis = { row_count: 1, valid: true };

    expect(typeof genesis.row_count).toBe("number");
    expect(() => assertM2HttpGenesisResult(pgResult([genesis]))).not.toThrow();
  });

  it.each([
    { rows: [], rowCount: 0 },
    { rows: [{ row_count: 0, valid: null }], rowCount: 1 },
    { rows: [{ row_count: 1, valid: false }], rowCount: 1 },
  ])("rechaza génesis ausente o incorrecta: $rows", ({ rows, rowCount }) => {
    const result = { rows, rowCount };

    expect(() => assertM2HttpGenesisResult(result))
      .toThrow("M2_HTTP_MIGRATION_GENESIS_POSTCHECK_FAILED");
  });
});
