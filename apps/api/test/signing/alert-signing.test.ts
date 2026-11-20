import { CompactSign, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";

import {
  InMemoryTrustedPublicKeyCatalog,
  JoseAlertSigner,
  SigningError,
  verifyAlertJws,
} from "../../src/modules/signing/index.js";

const encoder = new TextEncoder();

async function createFixture() {
  const trusted = await generateKeyPair("ES256");
  const other = await generateKeyPair("ES256");
  const kid = "siga-e-test-key-1";
  const signer = new JoseAlertSigner(trusted.privateKey, kid);
  const catalog = new InMemoryTrustedPublicKeyCatalog([[kid, trusted.publicKey]]);

  return { trusted, other, kid, signer, catalog };
}

function replaceFirstCharacter(segment: string): string {
  return `${segment[0] === "A" ? "B" : "A"}${segment.slice(1)}`;
}

describe("JWS compacto ES256", () => {
  it("firma y verifica los bytes exactos sin reserializarlos", async () => {
    const { signer, catalog, kid } = await createFixture();
    const payloadBytes = encoder.encode('{ "notice": "SIMULACRO", "n": 1 }\n');

    const jws = await signer.sign(payloadBytes);
    const verified = await verifyAlertJws(jws, catalog);

    expect(jws.split(".")).toHaveLength(3);
    expect(verified).toMatchObject({ alg: "ES256", kid });
    expect(verified.payloadBytes).toEqual(payloadBytes);
    expect(Buffer.from(jws.split(".")[2]!, "base64url")).toHaveLength(64);
  });

  it("rechaza una firma verificada con otra clave", async () => {
    const { signer, other, kid } = await createFixture();
    const jws = await signer.sign(encoder.encode("SIMULACRO"));
    const wrongCatalog = new InMemoryTrustedPublicKeyCatalog([[kid, other.publicKey]]);

    await expect(verifyAlertJws(jws, wrongCatalog)).rejects.toMatchObject({
      code: "SIGNATURE_VERIFICATION_FAILED",
    });
  });

  it("rechaza payload y cabecera alterados", async () => {
    const { signer, catalog } = await createFixture();
    const jws = await signer.sign(encoder.encode("SIMULACRO"));
    const [header, payload, signature] = jws.split(".") as [string, string, string];
    const changedPayload = `${header}.${replaceFirstCharacter(payload)}.${signature}`;
    const changedHeader = `${replaceFirstCharacter(header)}.${payload}.${signature}`;

    await expect(verifyAlertJws(changedPayload, catalog)).rejects.toBeInstanceOf(SigningError);
    await expect(verifyAlertJws(changedHeader, catalog)).rejects.toBeInstanceOf(SigningError);
  });

  it("rechaza una firma alterada o truncada", async () => {
    const { signer, catalog } = await createFixture();
    const jws = await signer.sign(encoder.encode("SIMULACRO"));
    const [header, payload, signature] = jws.split(".") as [string, string, string];
    const changedSignature = `${header}.${payload}.${replaceFirstCharacter(signature)}`;
    const truncatedSignature = `${header}.${payload}.${Buffer.from(signature, "base64url")
      .subarray(0, 63).toString("base64url")}`;

    await expect(verifyAlertJws(changedSignature, catalog)).rejects.toMatchObject({
      code: "SIGNATURE_VERIFICATION_FAILED",
    });
    await expect(verifyAlertJws(truncatedSignature, catalog)).rejects.toMatchObject({
      code: "INVALID_COMPACT_JWS",
    });
  });

  it("rechaza alg=none y algoritmos distintos de ES256", async () => {
    const { catalog } = await createFixture();
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", kid: "siga-e-test-key-1" }))
      .toString("base64url");
    const payload = Buffer.from("SIMULACRO").toString("base64url");
    const signature = Buffer.alloc(64).toString("base64url");
    const noneJws = `${noneHeader}.${payload}.${signature}`;

    await expect(verifyAlertJws(noneJws, catalog)).rejects.toMatchObject({
      code: "INVALID_PROTECTED_HEADER",
    });

    const hs256Jws = await new CompactSign(encoder.encode("SIMULACRO"))
      .setProtectedHeader({ alg: "HS256", kid: "siga-e-test-key-1" })
      .sign(new Uint8Array(32).fill(9));
    const [hsHeader, hsPayload] = hs256Jws.split(".");
    await expect(verifyAlertJws(`${hsHeader}.${hsPayload}.${signature}`, catalog)).rejects.toMatchObject({
      code: "INVALID_PROTECTED_HEADER",
    });
  });

  it("rechaza un kid desconocido aunque la firma sea criptográficamente válida", async () => {
    const { trusted, catalog } = await createFixture();
    const jws = await new CompactSign(encoder.encode("SIMULACRO"))
      .setProtectedHeader({ alg: "ES256", kid: "desconocido" })
      .sign(trusted.privateKey);

    await expect(verifyAlertJws(jws, catalog)).rejects.toMatchObject({
      code: "UNTRUSTED_KEY",
    });
  });

  it.each([
    ["jwk", { kty: "EC", crv: "P-256", x: "AA", y: "AA" }],
    ["jku", "https://attacker.invalid/jwks.json"],
    ["x5u", "https://attacker.invalid/certificate.pem"],
  ])("rechaza material de confianza controlado por la cabecera: %s", async (name, value) => {
    const { trusted, kid, catalog } = await createFixture();
    const jws = await new CompactSign(encoder.encode("SIMULACRO"))
      .setProtectedHeader({ alg: "ES256", kid, [name]: value })
      .sign(trusted.privateKey);

    await expect(verifyAlertJws(jws, catalog)).rejects.toMatchObject({
      code: "INVALID_PROTECTED_HEADER",
    });
  });

  it("rechaza serializaciones que no tengan tres segmentos compactos exactos", async () => {
    const { catalog } = await createFixture();
    const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: "siga-e-test-key-1" })).toString("base64url");
    const payload = Buffer.from("SIMULACRO").toString("base64url");

    await expect(verifyAlertJws("uno.dos", catalog)).rejects.toMatchObject({
      code: "INVALID_COMPACT_JWS",
    });
    await expect(verifyAlertJws("uno.dos.tres.cuatro", catalog)).rejects.toMatchObject({
      code: "INVALID_COMPACT_JWS",
    });
    await expect(verifyAlertJws(`${header}.${payload}.`, catalog)).rejects.toMatchObject({
      code: "INVALID_COMPACT_JWS",
    });
    await expect(verifyAlertJws("a=.Yg.Yw", catalog)).rejects.toMatchObject({
      code: "INVALID_COMPACT_JWS",
    });
    await expect(verifyAlertJws(`${"a".repeat(256 * 1024 + 1)}.Yg.Yw`, catalog)).rejects.toMatchObject({
      code: "INVALID_COMPACT_JWS",
    });
  });

  it("solo acepta claves de firma y confianza ECDSA P-256 con uso correcto", async () => {
    const p384 = await generateKeyPair("ES384");
    const rsa = await generateKeyPair("RS256");
    const { trusted } = await createFixture();

    expect(() => new JoseAlertSigner(trusted.publicKey, "wrong-type")).toThrow(SigningError);
    expect(() => new JoseAlertSigner(p384.privateKey, "wrong-curve")).toThrow(SigningError);
    expect(() => new InMemoryTrustedPublicKeyCatalog([["wrong-curve", p384.publicKey]])).toThrow(SigningError);
    expect(() => new InMemoryTrustedPublicKeyCatalog([["wrong-type", rsa.publicKey]])).toThrow(SigningError);
    expect(() => new InMemoryTrustedPublicKeyCatalog([
      ["duplicate", trusted.publicKey], ["duplicate", trusted.publicKey],
    ])).toThrow(SigningError);

    expect(() => new InMemoryTrustedPublicKeyCatalog([["private-key", trusted.privateKey]])).toThrow(SigningError);
  });
});
