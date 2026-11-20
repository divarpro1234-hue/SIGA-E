import { createHmac } from "node:crypto";

import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { appendAuditEvent } from "../audit/append-audit-event.js";
import { decryptTotpSecret, verifyTotpStep } from "./totp.js";
import { hashOpaqueToken, isCanonicalOpaqueToken, newOpaqueToken } from "./opaque-token.js";
import { verifyPassword } from "./password.js";

const reject = { ok: false as const, reason: "invalid" as const };
const limited = { ok: false as const, reason: "limited" as const };
const lockMs = 15 * 60_000;
const challengeMs = 5 * 60_000;
const sessionMs = 8 * 60 * 60_000;

type User = { id: string; name: string; email: string; role: "AUTHOR" | "APPROVER" | "ADMIN"; status: string;
  passwordHash: string | null; totpSecretCiphertext: Uint8Array | null; failedAttempts: number;
  lockedUntil: Date | null; lastTotpStep: bigint | null };

export type LoginResult = typeof reject | typeof limited | { ok: true; challengeId: string; expiresAt: string };
export type VerifyResult = typeof reject | typeof limited | { ok: true; token: string;
  user: Pick<User, "id" | "name" | "email" | "role" | "status"> };

export interface LoginService {
  login(email: string, password: string, source: string, now?: Date): Promise<LoginResult>;
  verify(challengeId: string, code: string, source: string, now?: Date): Promise<VerifyResult>;
  logout(token: string, userId: string, now?: Date): Promise<void>;
}

export class PrismaLoginService implements LoginService {
  constructor(private readonly prisma: PrismaClient, private readonly totpKey: Uint8Array,
    private readonly rateSecret: Uint8Array) {
    if (totpKey.length !== 32 || rateSecret.length < 32) throw new TypeError("M1_SECRET_INVALID");
  }

  private async rate(tx: Prisma.TransactionClient, source: string, operation: string, now: Date): Promise<boolean> {
    const windowStart = new Date(Math.floor(now.getTime() / 900_000) * 900_000);
    const keyHash = createHmac("sha256", this.rateSecret).update(`${operation}\n${source}`).digest();
    const rows = await tx.$queryRaw<Array<{ attempt_count: number }>>`
      INSERT INTO identity_rate_limits (key_hash, window_start, attempt_count)
      VALUES (${keyHash}, ${windowStart}, 1)
      ON CONFLICT (key_hash, window_start) DO UPDATE
      SET attempt_count = identity_rate_limits.attempt_count + 1
      RETURNING attempt_count`;
    return (rows[0]?.attempt_count ?? 21) <= 20;
  }

  private async lockedUser(tx: Prisma.TransactionClient, id: string): Promise<User | null> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${id}::uuid FOR UPDATE`;
    return tx.user.findUnique({ where: { id } });
  }

  private async serializable<T>(operation: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(operation, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2034") || attempt === 2) throw error;
      }
    }
    throw new Error("AUTH_TRANSACTION_UNAVAILABLE");
  }

  private async failure(tx: Prisma.TransactionClient, user: User, now: Date, kind: string): Promise<void> {
    const attempts = user.lockedUntil && user.lockedUntil <= now ? 1 : user.failedAttempts + 1;
    const lock = attempts >= 5 ? new Date(now.getTime() + lockMs) : null;
    await tx.user.update({ where: { id: user.id }, data: { failedAttempts: attempts, lockedUntil: lock } });
    if (lock) await tx.identityChallenge.updateMany({ where: { userId: user.id, kind: "LOGIN", consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_FAILURE", objectType: "USER", objectId: user.id,
      redactedDetails: { kind, attemptCount: attempts, result: lock ? "LOCKED" : "REJECTED" }, occurredAt: now });
  }

  async login(email: string, password: string, source: string, now = new Date()): Promise<LoginResult> {
    const normalizedEmail = email.trim().toLowerCase();
    // El cálculo señuelo se efectúa incluso para cuentas inexistentes; no se crea sesión.
    const candidate = await this.prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (!candidate) await verifyPassword(password, DUMMY_PASSWORD_HASH);
    const token = newOpaqueToken();
    const result = await this.serializable(async (tx) => {
      const allowed = await this.rate(tx, source, "LOGIN", now);
      if (!candidate) {
        await appendAuditEvent(tx, { actorId: null, action: "AUTH_FAILURE", objectType: "AUTH", objectId: "UNKNOWN",
          redactedDetails: { kind: "PASSWORD", result: allowed ? "REJECTED" : "LIMITED" }, occurredAt: now });
        return allowed ? reject : limited;
      }
      const user = await this.lockedUser(tx, candidate.id);
      if (!user) {
        await appendAuditEvent(tx, { actorId: null, action: "AUTH_FAILURE", objectType: "AUTH", objectId: "UNKNOWN",
          redactedDetails: { kind: "PASSWORD", result: "REJECTED" }, occurredAt: now });
        return reject;
      }
      if (!allowed) {
        await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_RATE_LIMIT", objectType: "USER", objectId: user.id,
          redactedDetails: { kind: "LOGIN", result: "LIMITED" }, occurredAt: now });
        return limited;
      }
      if (user.status !== "ACTIVE" || (user.lockedUntil && user.lockedUntil > now)) {
        await verifyPassword(password, DUMMY_PASSWORD_HASH);
        await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_FAILURE", objectType: "USER", objectId: user.id,
          redactedDetails: { kind: "PASSWORD", result: "REJECTED" }, occurredAt: now });
        return reject;
      }
      const valid = user.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
      if (!valid || !user.totpSecretCiphertext) {
        await this.failure(tx, user, now, "PASSWORD");
        return reject;
      }
      await tx.identityChallenge.updateMany({ where: { userId: user.id, kind: "LOGIN", consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
      const expiresAt = new Date(now.getTime() + challengeMs);
      await tx.identityChallenge.create({ data: { userId: user.id, kind: "LOGIN", tokenHash: new Uint8Array(hashOpaqueToken(token)), expiresAt } });
      await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_CHALLENGE_CREATED", objectType: "USER", objectId: user.id,
        redactedDetails: { kind: "LOGIN", result: "CHALLENGE" }, occurredAt: now });
      return { ok: true as const, challengeId: token, expiresAt: expiresAt.toISOString() };
    });
    return result;
  }

  async verify(challengeId: string, code: string, source: string, now = new Date()): Promise<VerifyResult> {
    const validToken = isCanonicalOpaqueToken(challengeId);
    const challenge = validToken ? await this.prisma.identityChallenge.findUnique({
      where: { tokenHash: new Uint8Array(hashOpaqueToken(challengeId)) }, select: { id: true, userId: true, kind: true },
    }) : null;
    const sessionToken = newOpaqueToken();
    return this.serializable(async (tx) => {
      const allowed = await this.rate(tx, source, "TOTP", now);
      if (!challenge || challenge.kind !== "LOGIN") {
        await appendAuditEvent(tx, { actorId: null, action: "AUTH_FAILURE", objectType: "AUTH", objectId: "UNKNOWN",
          redactedDetails: { kind: "TOTP", result: allowed ? "REJECTED" : "LIMITED" }, occurredAt: now });
        return allowed ? reject : limited;
      }
      const user = await this.lockedUser(tx, challenge.userId);
      if (!user) {
        await appendAuditEvent(tx, { actorId: null, action: "AUTH_FAILURE", objectType: "AUTH", objectId: "UNKNOWN",
          redactedDetails: { kind: "TOTP", result: "REJECTED" }, occurredAt: now });
        return reject;
      }
      await tx.$queryRaw`SELECT id FROM identity_challenges WHERE id = ${challenge.id}::uuid FOR UPDATE`;
      const current = await tx.identityChallenge.findUnique({ where: { id: challenge.id } });
      if (!allowed) {
        await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_RATE_LIMIT", objectType: "USER", objectId: user.id,
          redactedDetails: { kind: "TOTP", result: "LIMITED" }, occurredAt: now });
        return limited;
      }
      if (!current || current.kind !== "LOGIN" || current.consumedAt || current.revokedAt || current.expiresAt <= now ||
          current.failedAttempts >= 3 || user.status !== "ACTIVE" || !user.totpSecretCiphertext ||
          (user.lockedUntil && user.lockedUntil > now)) {
        await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_FAILURE", objectType: "USER", objectId: user.id,
          redactedDetails: { kind: "CHALLENGE", result: "REJECTED" }, occurredAt: now });
        return reject;
      }
      const secret = decryptTotpSecret(user.totpSecretCiphertext, this.totpKey);
      const step = verifyTotpStep(secret, code, now, user.lastTotpStep);
      if (step === null) {
        const failures = current.failedAttempts + 1;
        await tx.identityChallenge.update({ where: { id: current.id }, data: {
          failedAttempts: failures, ...(failures >= 3 ? { revokedAt: now } : {}),
        } });
        await this.failure(tx, user, now, "TOTP");
        return reject;
      }
      await tx.identityChallenge.update({ where: { id: current.id }, data: { consumedAt: now } });
      await tx.user.update({ where: { id: user.id }, data: { lastTotpStep: step, failedAttempts: 0, lockedUntil: null } });
      await tx.session.create({ data: { userId: user.id, tokenHash: new Uint8Array(hashOpaqueToken(sessionToken)),
        expiresAt: new Date(now.getTime() + sessionMs), lastSeenAt: now } });
      await appendAuditEvent(tx, { actorId: user.id, action: "AUTH_MFA_SUCCESS", objectType: "USER", objectId: user.id,
        redactedDetails: { kind: "LOGIN", result: "SUCCESS" }, occurredAt: now });
      return { ok: true as const, token: sessionToken,
        user: { id: user.id, name: user.name, email: user.email, role: user.role, status: user.status } };
    });
  }

  async logout(token: string, userId: string, now = new Date()): Promise<void> {
    await this.serializable(async (tx) => {
      await tx.session.updateMany({ where: { tokenHash: new Uint8Array(hashOpaqueToken(token)), userId, revokedAt: null }, data: { revokedAt: now } });
      await appendAuditEvent(tx, { actorId: userId, action: "AUTH_LOGOUT", objectType: "USER", objectId: userId,
        redactedDetails: { result: "REVOKED" }, occurredAt: now });
    });
  }
}

// PHC fijo ficticio: solo consume trabajo Argon2id en búsquedas de cuentas inexistentes.
const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
