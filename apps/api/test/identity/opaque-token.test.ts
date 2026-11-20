import { describe, expect, it } from "vitest";

import { hashOpaqueToken, isCanonicalOpaqueToken, newOpaqueToken } from "../../src/modules/identity/opaque-token.js";

describe("tokens opacos M1", () => {
  it("genera 32 bytes CSPRNG codificados canónicamente y hashes de 32 bytes", () => {
    const first = newOpaqueToken();
    const second = newOpaqueToken();
    expect(isCanonicalOpaqueToken(first)).toBe(true);
    expect(isCanonicalOpaqueToken(second)).toBe(true);
    expect(second).not.toBe(first);
    expect(hashOpaqueToken(first)).toHaveLength(32);
    expect(hashOpaqueToken(first)).toEqual(hashOpaqueToken(first));
    expect(hashOpaqueToken(first)).not.toEqual(hashOpaqueToken(second));
  });

  it("rechaza padding, caracteres y longitud no canónicos", () => {
    const token = newOpaqueToken();
    for (const value of [`${token}=`, `${token.slice(1)}`, `${token.slice(0, -1)}+`, "x", ""] ) {
      expect(isCanonicalOpaqueToken(value)).toBe(false);
      expect(() => hashOpaqueToken(value)).toThrow("TOKEN_INVALIDO");
    }
  });
});
