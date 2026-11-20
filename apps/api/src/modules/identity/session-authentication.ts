import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { ApplicationError } from "../../domain/errors/application-error.js";
import type { InternalUser, SessionReader } from "./session-reader.js";

const opaqueTokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idleLimitMs = 30 * 60 * 1000;

export function readSessionCookie(header: string | undefined): string | null {
  if (!header || header.length > 8192) return null;
  const values = header.split(";").map((part) => part.trim())
    .filter((part) => part.startsWith("sigae_session="));
  if (values.length !== 1) return null;
  const token = values[0]?.slice("sigae_session=".length);
  return token && opaqueTokenPattern.test(token) &&
    Buffer.from(token, "base64url").length === 32 &&
    Buffer.from(token, "base64url").toString("base64url") === token ? token : null;
}

export function authRequired(): ApplicationError {
  return new ApplicationError(401, "AUTH_REQUIRED", "Autenticación requerida",
    "La sesión no está disponible o no es válida.");
}

export async function authenticateSession(
  cookieHeader: string | undefined,
  reader: SessionReader,
  now: Date = new Date(),
): Promise<InternalUser> {
  const token = readSessionCookie(cookieHeader);
  if (!token) throw authRequired();
  const hash = createHash("sha256").update(token, "ascii").digest();
  const session = await reader.findByTokenHash(hash);
  if (!session || session.revokedAt !== null || session.expiresAt <= now ||
      session.lastSeenAt > now || now.getTime() - session.lastSeenAt.getTime() >= idleLimitMs ||
      session.user.status !== "ACTIVE") throw authRequired();
  if (!await reader.touchIfActive(hash, now, new Date(now.getTime() - idleLimitMs))) throw authRequired();
  return session.user;
}

export function csrfTokenForSession(token: string, secret: Uint8Array): string {
  if (secret.length < 32 || !opaqueTokenPattern.test(token)) throw authRequired();
  return createHmac("sha256", secret).update("SIGA-E-CSRF-v1\n", "utf8")
    .update(token, "ascii").digest("base64url");
}

export function validCsrfToken(token: string, supplied: string, secret: Uint8Array): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false;
  const expected = csrfTokenForSession(token, secret);
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

export function requireRole(user: InternalUser, allowed: readonly InternalUser["role"][]): void {
  if (!allowed.includes(user.role)) {
    throw new ApplicationError(403, "ROLE_FORBIDDEN", "Operación no autorizada",
      "El rol no permite esta operación.");
  }
}
