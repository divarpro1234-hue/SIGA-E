import { argon2, randomBytes, timingSafeEqual } from "node:crypto";

const memory = 19_456;
const passes = 2;
const parallelism = 1;
const tagLength = 32;
const phcPattern = /^\$argon2id\$v=19\$m=19456,t=2,p=1\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/u;
const common = new Set(["password123456", "123456789012", "contrasena123", "contraseña123", "siga-e123456", "administrador123"]);

export function normalizePassword(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("PASSWORD_INVALID");
  const normalized = value.normalize("NFC");
  const codePoints = Array.from(normalized).length;
  if (codePoints < 12 || codePoints > 128 || Buffer.byteLength(normalized, "utf8") > 512 ||
      /[\u0000-\u001f\u007f]/u.test(normalized) || common.has(normalized.toLocaleLowerCase("und"))) {
    throw new TypeError("PASSWORD_INVALID");
  }
  return normalized;
}

function derive(password: string, salt: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => argon2("argon2id", {
    message: Buffer.from(password, "utf8"), nonce: salt,
    parallelism, tagLength, memory, passes,
  }, (error, derived) => error ? reject(error) : resolve(derived)));
}

function encode(buffer: Uint8Array): string { return Buffer.from(buffer).toString("base64").replace(/=+$/u, ""); }

export async function hashPassword(value: unknown): Promise<string> {
  const password = normalizePassword(value);
  const salt = randomBytes(16);
  const tag = await derive(password, salt);
  return `$argon2id$v=19$m=${memory},t=${passes},p=${parallelism}$${encode(salt)}$${encode(tag)}`;
}

export async function verifyPassword(value: unknown, encodedHash: string): Promise<boolean> {
  const match = phcPattern.exec(encodedHash);
  if (!match) return false;
  let password: string;
  try { password = normalizePassword(value); } catch { return false; }
  const salt = Buffer.from(match[1]!, "base64");
  const stored = Buffer.from(match[2]!, "base64");
  if (salt.length !== 16 || stored.length !== tagLength || encode(salt) !== match[1] || encode(stored) !== match[2]) return false;
  const candidate = await derive(password, salt);
  return timingSafeEqual(candidate, stored);
}

/** Medición local informativa; no sustituye la decisión de calibración del equipo objetivo. */
export async function measureArgon2idMs(sample: string): Promise<number> {
  const start = performance.now();
  await hashPassword(sample);
  return performance.now() - start;
}
