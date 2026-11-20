import { CompactSign, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import { calcularJwsHash, calcularMessageKey, verificarJws } from "../src/index.js";
import type { CatalogoConfianza, ResultadoFirma } from "../src/index.js";

const encoder = new TextEncoder();
const now = new Date("2026-10-09T12:30:00Z");
const sent = "2026-10-09T12:00:00Z";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    sender: "urn:siga-e:simulacro",
    identifier: "SIGAE-2026-0001",
    sent,
    status: "Exercise",
    scope: "Public",
    msgType: "Alert",
    info: {
      scenario: "SISMO",
      event: "Simulacro de sismo",
      severity: "Moderate",
      urgency: "Immediate",
      certainty: "Likely",
      headline: "SIMULACRO: aviso ficticio de sismo",
      description: "Ejercicio académico; no es una alerta real.",
      expires: "2026-10-09T13:00:00Z",
      areaDesc: "Sector ficticio A",
    },
    ...overrides,
  };
}

async function fixture(estado: "activa" | "retirada" | "revocada" = "activa") {
  const pair = await generateKeyPair("ES256", { extractable: true });
  const kid = "siga-e-test-key";
  const publicJwk = await exportJWK(pair.publicKey);
  const confianza: CatalogoConfianza = {
    claves: [{
      kid,
      estado,
      validFrom: "2026-10-01T00:00:00Z",
      retiredAt: estado === "retirada" ? "2026-10-09T12:15:00Z" : null,
      revokedAt: estado === "revocada" ? "2026-10-09T12:20:00Z" : null,
      publicJwk,
    }],
  };
  async function sign(content: unknown) {
    return new CompactSign(encoder.encode(JSON.stringify(content)))
      .setProtectedHeader({ alg: "ES256", kid })
      .sign(pair.privateKey);
  }
  return { pair, kid, confianza, sign };
}

function lowerHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function expectHidden(result: ResultadoFirma) {
  expect(result.firma).not.toBe("VALIDA");
  expect(result.payload).toBeNull();
}

describe("@siga-e/verify", () => {
  it("verifica ES256 y devuelve payload solo tras cumplir firma y política", async () => {
    const f = await fixture();
    const alert = payload();
    const jws = await f.sign(alert);
    const result = await verificarJws(jws, f.confianza, now);
    expect(result).toMatchObject({ firma: "VALIDA", vigencia: "VIGENTE", kid: f.kid, payload: alert });
    expect(result.jwsHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("clasifica firma inválida con clave equivocada, incluso si está revocada", async () => {
    const signed = await fixture();
    const wrong = await fixture("revocada");
    const jws = await signed.sign(payload());
    const result = await verificarJws(jws, wrong.confianza, now);
    expect(result.firma).toBe("INVALIDA");
    expectHidden(result);
  });

  it("rechaza payload y cabecera alterados", async () => {
    const f = await fixture();
    const [header, body, signature] = (await f.sign(payload())).split(".");
    const alteredPayload = `${header}.A${body?.slice(1)}.${signature}`;
    const alteredHeader = `A${header?.slice(1)}.${body}.${signature}`;
    expectHidden(await verificarJws(alteredPayload, f.confianza, now));
    expectHidden(await verificarJws(alteredHeader, f.confianza, now));
  });

  it("rechaza alg=none y otro algoritmo", async () => {
    const f = await fixture();
    const encoded = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    expectHidden(await verificarJws(`${encoded({ alg: "none", kid: f.kid })}.${encoded(payload())}.AA`, f.confianza, now));
    const hs = await new CompactSign(encoder.encode(JSON.stringify(payload())))
      .setProtectedHeader({ alg: "HS256", kid: f.kid })
      .sign(new Uint8Array(32).fill(7));
    expectHidden(await verificarJws(hs, f.confianza, now));
  });

  it.each(["jwk", "jku", "x5u", "x5c", "crit"])("rechaza encabezado %s", async (name) => {
    const f = await fixture();
    const [header, body, signature] = (await f.sign(payload())).split(".");
    expect(header).toBeTruthy();
    const forbiddenHeader = { alg: "ES256", kid: f.kid, [name]: name === "crit" ? ["exp"] : "controlado" };
    const encoded = btoa(JSON.stringify(forbiddenHeader)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
    expectHidden(await verificarJws(`${encoded}.${body}.${signature}`, f.confianza, now));
  });

  it("distingue kid desconocido y clave revocada solo después de verificar firma", async () => {
    const f = await fixture("revocada");
    const jws = await f.sign(payload());
    const unknown = await verificarJws(jws, { claves: [] }, now);
    expect(unknown.firma).toBe("CLAVE_DESCONOCIDA");
    expectHidden(unknown);
    const revoked = await verificarJws(jws, f.confianza, now);
    expect(revoked.firma).toBe("CLAVE_REVOCADA");
    expectHidden(revoked);
  });

  it("acepta clave retirada para mensaje histórico y rechaza emisión posterior al retiro", async () => {
    const f = await fixture("retirada");
    expect((await verificarJws(await f.sign(payload()), f.confianza, now)).firma).toBe("VALIDA");
    const later = payload({ sent: "2026-10-09T12:16:00Z" });
    const result = await verificarJws(await f.sign(later), f.confianza, now);
    expect(result.firma).toBe("FUERA_DE_POLITICA");
    expectHidden(result);
  });

  it("clasifica política inválida sin exponer payload, aunque la firma sea correcta", async () => {
    const f = await fixture();
    for (const content of [payload({ status: "Actual" }), payload({ scope: "Private" }),
      payload({ info: { ...payload().info, headline: "Aviso ficticio sin leyenda" } }),
      payload({ info: { ...payload().info, expires: sent } }),
      payload({ sent: "2026-02-30T12:00:00Z" })]) {
      const result = await verificarJws(await f.sign(content), f.confianza, now);
      expect(result.firma).toBe("FUERA_DE_POLITICA");
      expectHidden(result);
    }
  });

  it("clasifica JSON firmado pero malformado como fuera de política", async () => {
    const f = await fixture();
    const jws = await new CompactSign(encoder.encode("{JSON incompleto"))
      .setProtectedHeader({ alg: "ES256", kid: f.kid })
      .sign(f.pair.privateKey);
    const result = await verificarJws(jws, f.confianza, now);
    expect(result.firma).toBe("FUERA_DE_POLITICA");
    expectHidden(result);
  });

  it("separa vigencia de firma y usa exclusivamente ahora", async () => {
    const f = await fixture();
    const jws = await f.sign(payload());
    expect((await verificarJws(jws, f.confianza, new Date("2026-10-09T13:00:00Z"))).vigencia).toBe("VENCIDA");
    expect((await verificarJws(jws, f.confianza, new Date("2026-10-09T11:59:59Z"))).vigencia).toBe("DESCONOCIDA");
    const expired = await verificarJws(jws, f.confianza, new Date("2026-10-11T00:00:00Z"));
    expect(expired).toMatchObject({ firma: "VALIDA", vigencia: "VENCIDA" });
    expect(expired.payload).not.toBeNull();
  });

  it("rechaza estructura compacta malformada y longitud superior a 32768 sin rechazar promesa", async () => {
    const f = await fixture();
    for (const bad of ["a.b", "a.b.c.d", "á.b.c", "a..c", `${"a".repeat(32765)}.b.c`]) {
      const result = await verificarJws(bad, f.confianza, now);
      expect(result.firma).toBe("INVALIDA");
      expectHidden(result);
    }
  });

  it.each(["\u202e", "\u061c", "\u0000", "\u200b", "\u00ad", "\u034f", "\u115f",
    "\u1160", "\u3164", "\uffa0", "\u17b4", "\u180b", "\u2061", "\u2028", "\u2029",
    "\ufe00", "\u{e0100}", "\u{e0001}"])("rechaza Unicode prohibido %s", async (character) => {
    const f = await fixture();
    const content = payload({ info: { ...payload().info, description: `Ejercicio académico ${character} ficticio.` } });
    expectHidden(await verificarJws(await f.sign(content), f.confianza, now));
  });

  it("permite U+200C, U+200D y selectores FE0E/FE0F", async () => {
    const f = await fixture();
    const content = payload({ info: { ...payload().info, description: "Ejercicio ficticio \u200c\u200d\ufe0e\ufe0f de prueba." } });
    expect((await verificarJws(await f.sign(content), f.confianza, now)).firma).toBe("VALIDA");
  });

  it("coincide con los vectores independientes del Prompt 03, en bytes exactos", async () => {
    expect(lowerHex(await calcularJwsHash("aaa.bbb.ccc"))).toBe("ce887a8eece06ba329c188b9cf872bd8a70a0c354275fe3c435450024784c9de");
    expect(lowerHex(await calcularMessageKey("urn:siga-e:simulacro", "SIGAE-2026-0001", "2026-10-09T12:34:56-04:00")))
      .toBe("22bbe621f0bab63eda60e623c0fd80b4b5151cefda73f35d78882431486a2c77");
    expect(() => calcularMessageKey("emisor\nmalicioso", "id", sent)).toThrow();
  });

  it("no acepta JWK privado en el catálogo", async () => {
    const f = await fixture();
    const privateJwk = await exportJWK(f.pair.privateKey);
    const result = await verificarJws(await f.sign(payload()), {
      claves: [{ kid: f.kid, estado: "activa", validFrom: "2026-10-01T00:00:00Z", publicJwk: privateJwk }],
    }, now);
    expect(result.firma).toBe("FUERA_DE_POLITICA");
    expectHidden(result);
  });
});
