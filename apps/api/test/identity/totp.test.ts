import { describe, expect, it } from "vitest";

import { decryptTotpSecret, encryptTotpSecret, newTotpSecret, totpCodeForTest, totpEnrollmentUri, verifyTotpStep } from "../../src/modules/identity/totp.js";

const secret = new Uint8Array(20).fill(17);
const now = new Date("2026-10-12T12:00:00.000Z");

describe("TOTP M1", () => {
  it("acepta ventana ±1 y rechaza código erróneo, vencido y paso reutilizado", () => {
    const currentCode = totpCodeForTest(secret, now);
    const step = verifyTotpStep(secret, currentCode, now, null);
    expect(step).not.toBeNull();
    expect(verifyTotpStep(secret, currentCode, now, step)).toBeNull();
    expect(verifyTotpStep(secret, "abcdef", now, null)).toBeNull();
    expect(verifyTotpStep(secret, totpCodeForTest(secret, new Date(now.getTime() - 90_000)), now, null)).toBeNull();
    expect(verifyTotpStep(secret, totpCodeForTest(secret, new Date(now.getTime() - 30_000)), now, null)).not.toBeNull();
  });

  it("cifra con AES-256-GCM y rechaza modificación o clave incorrecta", () => {
    const key = new Uint8Array(32).fill(23);
    const blob = encryptTotpSecret(secret, key);
    expect(blob).not.toEqual(secret);
    expect(decryptTotpSecret(blob, key)).toEqual(secret);
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 1;
    expect(() => decryptTotpSecret(blob, key)).toThrow();
    expect(() => encryptTotpSecret(secret, new Uint8Array(16))).toThrow("TOTP_KEY_INVALID");
  });

  it("genera secreto de 160 bits y URI local de enrolamiento", () => {
    expect(newTotpSecret()).toHaveLength(20);
    const uri = totpEnrollmentUri(secret, "usuario@example.invalid");
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("digits=6");
    expect(uri).toContain("period=30");
  });
});
