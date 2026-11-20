import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import { verificarJws } from "../src/index.ts";

const fixtureUrl = (name) => new URL(`../fixtures/${name}`, import.meta.url);
const readJson = async (name) => JSON.parse(await readFile(fixtureUrl(name), "utf8"));

describe("fixtures públicos persistidos", () => {
  it("ejecuta verificarJws sobre los cinco JWS del manifiesto", async () => {
    const catalogo = await readJson("catalogo.json");
    const manifest = await readJson("manifest.json");
    expect(manifest.fixtures.map((entry) => entry.name)).toEqual([
      "valid-current", "tampered", "expired", "revoked", "unknown-kid",
    ]);
    for (const entry of manifest.fixtures) {
      const fixture = await readJson(entry.file);
      const result = await verificarJws(fixture.jws, catalogo, new Date(manifest.ahora));
      expect(result, entry.name).toMatchObject({
        firma: entry.firma, vigencia: entry.vigencia, kid: entry.kid, jwsHash: entry.jwsHash,
      });
      if (entry.firma === "VALIDA") {
        expect(result.payload, entry.name).not.toBeNull();
      } else {
        expect(result.payload, entry.name).toBeNull();
      }
    }
    for (const key of catalogo.claves) {
      expect(key.publicJwk).toMatchObject({ kty: "EC", crv: "P-256" });
      expect(Object.keys(key.publicJwk)).not.toContain("d");
    }
  });
});
