import { createHash, randomBytes } from "node:crypto";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;

/** Token opaco de 32 bytes CSPRNG. El llamador solo persiste su hash. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isCanonicalOpaqueToken(value: unknown): value is string {
  if (typeof value !== "string" || !tokenPattern.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

export function hashOpaqueToken(value: string): Uint8Array {
  if (!isCanonicalOpaqueToken(value)) throw new TypeError("TOKEN_INVALIDO");
  return new Uint8Array(createHash("sha256").update(value, "ascii").digest());
}
