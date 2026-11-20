import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const digits = 6;
const periodSeconds = 30;
const version = 1;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function newTotpSecret(): Uint8Array<ArrayBuffer> { return new Uint8Array(randomBytes(20)); }

export function encryptTotpSecret(secret: Uint8Array, key: Uint8Array): Uint8Array<ArrayBuffer> {
  if (secret.length < 20 || key.length !== 32) throw new TypeError("TOTP_KEY_INVALID");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(secret), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from([version]), nonce, cipher.getAuthTag(), ciphertext]));
}

export function decryptTotpSecret(blob: Uint8Array, key: Uint8Array): Uint8Array<ArrayBuffer> {
  if (key.length !== 32 || blob.length < 1 + 12 + 16 + 20 || blob[0] !== version) throw new TypeError("TOTP_CIPHERTEXT_INVALID");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  decipher.setAuthTag(blob.subarray(13, 29));
  return new Uint8Array(Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]));
}

function codeAtStep(secret: Uint8Array, step: bigint): string {
  if (secret.length < 20 || step < 0n) throw new TypeError("TOTP_INPUT_INVALID");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(step);
  const digest = createHmac("sha1", secret).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) | digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export function totpCodeForTest(secret: Uint8Array, at: Date): string {
  return codeAtStep(secret, BigInt(Math.floor(at.getTime() / 1000 / periodSeconds)));
}

/** Devuelve el paso a consumir atómicamente, o null si el código es inválido/reutilizado. */
export function verifyTotpStep(secret: Uint8Array, code: string, now: Date, lastAcceptedStep: bigint | null): bigint | null {
  if (!/^\d{6}$/u.test(code) || secret.length < 20 || !Number.isFinite(now.getTime())) return null;
  const current = BigInt(Math.floor(now.getTime() / 1000 / periodSeconds));
  for (const step of [current - 1n, current, current + 1n]) {
    if (step < 0n || (lastAcceptedStep !== null && step <= lastAcceptedStep)) continue;
    if (timingSafeEqual(Buffer.from(code), Buffer.from(codeAtStep(secret, step)))) return step;
  }
  return null;
}

function base32(bytes: Uint8Array): string {
  let result = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      result += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) result += base32Alphabet[(value << (5 - bits)) & 31];
  return result;
}

export function totpEnrollmentUri(secret: Uint8Array, accountLabel: string): string {
  if (secret.length < 20 || !accountLabel || accountLabel.length > 120) throw new TypeError("TOTP_INPUT_INVALID");
  const issuer = "SIGA-E SIMULACRO";
  const uri = new URL(`otpauth://totp/${encodeURIComponent(`${issuer}:${accountLabel}`)}`);
  uri.searchParams.set("secret", base32(secret));
  uri.searchParams.set("issuer", issuer);
  uri.searchParams.set("algorithm", "SHA1");
  uri.searchParams.set("digits", "6");
  uri.searchParams.set("period", "30");
  return uri.toString();
}
