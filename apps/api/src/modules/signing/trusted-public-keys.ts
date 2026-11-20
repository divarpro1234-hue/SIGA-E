import type { CryptoKey } from "jose";
import { SigningError } from "./signing-error.js";

export interface TrustedPublicKeyCatalog {
  resolve(kid: string): CryptoKey | undefined;
}

export class InMemoryTrustedPublicKeyCatalog implements TrustedPublicKeyCatalog {
  private readonly keys: ReadonlyMap<string, CryptoKey>;

  constructor(entries: ReadonlyArray<readonly [kid: string, key: CryptoKey]>) {
    const keys = new Map<string, CryptoKey>();
    for (const [kid, key] of entries) {
      if (typeof kid !== "string" || kid.length === 0 || keys.has(kid) ||
          key.type !== "public" || key.algorithm.name !== "ECDSA" ||
          !("namedCurve" in key.algorithm) || key.algorithm.namedCurve !== "P-256" ||
          !key.usages.includes("verify")) {
        throw new SigningError("INVALID_TRUSTED_KEY",
          "El catálogo requiere kid único y claves públicas ECDSA P-256 para verificar.");
      }
      keys.set(kid, key);
    }
    this.keys = keys;
  }

  resolve(kid: string): CryptoKey | undefined {
    return this.keys.get(kid);
  }
}
