import { describe, expect, it } from "vitest";

import { hashPassword, measureArgon2idMs, normalizePassword, verifyPassword } from "../../src/modules/identity/password.js";

const sample = "Frase ficticia extensa 2026";

describe("Argon2id M1", () => {
  it("normaliza NFC, codifica parámetros aprobados y verifica sin comparación de texto", async () => {
    expect(normalizePassword("Cafe\u0301 de prueba 2026")).toBe("Café de prueba 2026");
    const stored = await hashPassword(sample);
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(await verifyPassword(sample, stored)).toBe(true);
    expect(await verifyPassword("Frase ficticia errónea", stored)).toBe(false);
    expect(await hashPassword(sample)).not.toBe(stored);
  });

  it("rechaza entradas débiles, enormes y PHC alterado", async () => {
    for (const invalid of ["short", "password123456", "x".repeat(129), "x".repeat(11) + "\u0000"]) {
      expect(() => normalizePassword(invalid)).toThrow("PASSWORD_INVALID");
    }
    expect(await verifyPassword(sample, "$argon2id$v=19$m=1,t=1,p=1$abc$def")).toBe(false);
  });

  it("permite medir la calibración local sin fijar un tiempo no verificado", async () => {
    const ms = await measureArgon2idMs(sample);
    expect(ms).toBeGreaterThan(0);
    expect(Number.isFinite(ms)).toBe(true);
  });
});
