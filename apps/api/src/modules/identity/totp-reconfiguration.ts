import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { ApplicationError } from "../../domain/errors/application-error.js";
import { appendAuditEvent } from "../audit/append-audit-event.js";
import { hashOpaqueToken, isCanonicalOpaqueToken, newOpaqueToken } from "./opaque-token.js";
import { decryptTotpSecret, encryptTotpSecret, newTotpSecret, totpEnrollmentUri, verifyTotpStep } from "./totp.js";
import { verifyPassword } from "./password.js";
import { createHmac } from "node:crypto";

const challengeMs = 15 * 60_000;
const lockMs = 15 * 60_000;
const maxAttempts = 5;

type Transaction = Prisma.TransactionClient;

export interface TotpReconfigurationStart {
  readonly reconfigureToken: string;
  readonly expiresAt: string;
  readonly otpauthUri: string;
}

export interface TotpReconfigurationService {
  start(userId: string, password: string, currentCode: string, source: string,
    now?: Date): Promise<TotpReconfigurationStart>;
  confirm(userId: string, reconfigureToken: string, newCode: string, now?: Date): Promise<void>;
}

export class PrismaTotpReconfigurationService implements TotpReconfigurationService {
  constructor(private readonly prisma: PrismaClient, private readonly totpKey: Uint8Array,
    private readonly rateSecret: Uint8Array) {
    if (totpKey.length !== 32 || rateSecret.length < 32) throw new TypeError("M1_SECRET_INVALID");
  }

  private async serializable<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "P2034") {
          if (attempt < 2) continue;
          throw new ApplicationError(503, "TOTP_RECONFIGURE_UNAVAILABLE", "Servicio no disponible",
            "La operación no pudo completarse.");
        }
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
          throw new ApplicationError(409, "TOTP_RECONFIGURE_CONFLICT", "Operación en conflicto",
            "Ya existe una reconfiguración pendiente.");
        }
        throw error;
      }
    }
    throw new ApplicationError(503, "TOTP_RECONFIGURE_UNAVAILABLE", "Servicio no disponible",
      "La operación no pudo completarse.");
  }

  private async rate(tx: Transaction, source: string, now: Date): Promise<boolean> {
    const windowStart = new Date(Math.floor(now.getTime() / 900_000) * 900_000);
    const keyHash = createHmac("sha256", this.rateSecret)
      .update(`TOTP_RECONFIGURE\n${source}`, "utf8").digest();
    const rows = await tx.$queryRaw<Array<{ attempt_count: number }>>`
      INSERT INTO identity_rate_limits (key_hash, window_start, attempt_count)
      VALUES (${keyHash}, ${windowStart}, 1)
      ON CONFLICT (key_hash, window_start) DO UPDATE
      SET attempt_count = identity_rate_limits.attempt_count + 1
      RETURNING attempt_count`;
    return (rows[0]?.attempt_count ?? 21) <= 20;
  }

  private async lockUser(tx: Transaction, userId: string) {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`;
    return tx.user.findUnique({ where: { id: userId } });
  }

  private async failedCurrentFactor(tx: Transaction, user: {
    id: string; failedAttempts: number; lockedUntil: Date | null;
  }, kind: "PASSWORD" | "TOTP", now: Date): Promise<void> {
    const attempts = user.lockedUntil && user.lockedUntil <= now ? 1 : user.failedAttempts + 1;
    const lockedUntil = attempts >= maxAttempts ? new Date(now.getTime() + lockMs) : null;
    await tx.user.update({ where: { id: user.id }, data: { failedAttempts: attempts, lockedUntil } });
    await appendAuditEvent(tx, {
      actorId: user.id, action: "AUTH_FAILURE", objectType: "USER", objectId: user.id,
      redactedDetails: { kind, attemptCount: attempts, result: lockedUntil ? "LOCKED" : "REJECTED" },
      occurredAt: now,
    });
  }

  async start(userId: string, password: string, currentCode: string, source: string,
    now = new Date()): Promise<TotpReconfigurationStart> {
    const token = newOpaqueToken();
    const secret = newTotpSecret();
    const pendingCiphertext = encryptTotpSecret(secret, this.totpKey);
    const expiresAt = new Date(now.getTime() + challengeMs);

    const result = await this.serializable(async (tx): Promise<
      | { ok: true; value: TotpReconfigurationStart }
      | { ok: false; status: 401 | 429 | 409; code: string; title: string; detail: string }
    > => {
      const allowed = await this.rate(tx, source, now);
      const user = await this.lockUser(tx, userId);
      if (!user || user.status !== "ACTIVE" || !user.passwordHash || !user.totpSecretCiphertext ||
          !allowed || (user.lockedUntil && user.lockedUntil > now)) {
        await appendAuditEvent(tx, {
          actorId: user?.id ?? userId, action: "TOTP_RECONFIGURE_REJECTED", objectType: "USER", objectId: userId,
          redactedDetails: { kind: "START", result: allowed ? "REJECTED" : "LIMITED" }, occurredAt: now,
        });
        return allowed
          ? { ok: false, status: 401, code: "AUTH_REQUIRED", title: "Autenticación requerida",
            detail: "Las credenciales no son válidas." }
          : { ok: false, status: 429, code: "TOO_MANY_ATTEMPTS", title: "Demasiados intentos",
            detail: "Intente más tarde." };
      }

      if (!await verifyPassword(password, user.passwordHash)) {
        await this.failedCurrentFactor(tx, user, "PASSWORD", now);
        return { ok: false, status: 401, code: "AUTH_REQUIRED", title: "Autenticación requerida",
          detail: "Las credenciales no son válidas." };
      }
      const step = verifyTotpStep(decryptTotpSecret(user.totpSecretCiphertext, this.totpKey), currentCode, now, user.lastTotpStep);
      if (step === null) {
        await this.failedCurrentFactor(tx, user, "TOTP", now);
        return { ok: false, status: 401, code: "AUTH_REQUIRED", title: "Autenticación requerida",
          detail: "Las credenciales no son válidas." };
      }

      const open = await tx.identityChallenge.findFirst({
        where: { userId, kind: "TOTP_RECONFIGURE", consumedAt: null, revokedAt: null },
      });
      if (open) {
        if (open.expiresAt <= now) {
          await tx.identityChallenge.update({ where: { id: open.id }, data: { revokedAt: now } });
        } else {
          await appendAuditEvent(tx, {
            actorId: user.id, action: "TOTP_RECONFIGURE_REJECTED", objectType: "USER", objectId: user.id,
            redactedDetails: { kind: "START", result: "CONFLICT" }, occurredAt: now,
          });
          return { ok: false, status: 409, code: "TOTP_RECONFIGURE_CONFLICT", title: "Operación en conflicto",
            detail: "Ya existe una reconfiguración pendiente." };
        }
      }

      await tx.user.update({ where: { id: user.id }, data: { lastTotpStep: step, failedAttempts: 0, lockedUntil: null } });
      await tx.identityChallenge.create({ data: {
        userId, kind: "TOTP_RECONFIGURE", tokenHash: new Uint8Array(hashOpaqueToken(token)),
        pendingTotpCiphertext: pendingCiphertext, expiresAt,
      } });
      await appendAuditEvent(tx, {
        actorId: user.id, action: "TOTP_RECONFIGURE_STARTED", objectType: "USER", objectId: user.id,
        redactedDetails: { kind: "START", result: "PENDING" }, occurredAt: now,
      });
      return { ok: true, value: {
        reconfigureToken: token, expiresAt: expiresAt.toISOString(), otpauthUri: totpEnrollmentUri(secret, user.email),
      } };
    });
    if (!result.ok) throw new ApplicationError(result.status, result.code, result.title, result.detail);
    return result.value;
  }

  async confirm(userId: string, reconfigureToken: string, newCode: string, now = new Date()): Promise<void> {
    if (!isCanonicalOpaqueToken(reconfigureToken)) {
      throw new ApplicationError(401, "TOTP_RECONFIGURE_INVALID", "Operación no autorizada",
        "El desafío no es válido.");
    }
    const tokenHash = new Uint8Array(hashOpaqueToken(reconfigureToken));
    const accepted = await this.serializable(async (tx): Promise<boolean> => {
      const user = await this.lockUser(tx, userId);
      let challenge = await tx.identityChallenge.findUnique({ where: { tokenHash } });
      if (challenge) {
        await tx.$queryRaw`SELECT id FROM identity_challenges WHERE id = ${challenge.id}::uuid FOR UPDATE`;
        challenge = await tx.identityChallenge.findUnique({ where: { id: challenge.id } });
      }
      if (!user || user.status !== "ACTIVE" || (user.lockedUntil && user.lockedUntil > now)) {
        await appendAuditEvent(tx, {
          actorId: user?.id ?? userId, action: "TOTP_RECONFIGURE_REJECTED", objectType: "USER", objectId: userId,
          redactedDetails: { kind: "CONFIRM", result: "REJECTED" }, occurredAt: now,
        });
        return false;
      }
      if (!challenge || challenge.userId !== userId || challenge.kind !== "TOTP_RECONFIGURE" ||
          !challenge.pendingTotpCiphertext || challenge.consumedAt || challenge.revokedAt ||
          challenge.expiresAt <= now || challenge.failedAttempts >= maxAttempts) {
        await appendAuditEvent(tx, {
          actorId: user?.id ?? userId, action: "TOTP_RECONFIGURE_REJECTED", objectType: "USER", objectId: userId,
          redactedDetails: { kind: "CONFIRM", result: "REJECTED" }, occurredAt: now,
        });
        return false;
      }

      const pendingSecret = decryptTotpSecret(challenge.pendingTotpCiphertext, this.totpKey);
      const step = verifyTotpStep(pendingSecret, newCode, now, null);
      if (step === null) {
        const attempts = challenge.failedAttempts + 1;
        await tx.identityChallenge.update({ where: { id: challenge.id }, data: {
          failedAttempts: attempts, ...(attempts >= maxAttempts ? { revokedAt: now } : {}),
        } });
        await appendAuditEvent(tx, {
          actorId: user.id, action: "TOTP_RECONFIGURE_REJECTED", objectType: "USER", objectId: user.id,
          redactedDetails: { kind: "CONFIRM", attemptCount: attempts, result: "REJECTED" }, occurredAt: now,
        });
        return false;
      }

      await tx.user.update({ where: { id: user.id }, data: {
        totpSecretCiphertext: challenge.pendingTotpCiphertext, lastTotpStep: step,
      } });
      await tx.identityChallenge.update({ where: { id: challenge.id }, data: {
        consumedAt: now, pendingTotpCiphertext: null,
      } });
      await tx.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
      await appendAuditEvent(tx, {
        actorId: user.id, action: "TOTP_RECONFIGURED", objectType: "USER", objectId: user.id,
        redactedDetails: { kind: "CONFIRM", result: "SUCCESS" }, occurredAt: now,
      });
      return true;
    });
    if (!accepted) {
      throw new ApplicationError(401, "TOTP_RECONFIGURE_INVALID", "Operación no autorizada",
        "El desafío o código no es válido.");
    }
  }
}
