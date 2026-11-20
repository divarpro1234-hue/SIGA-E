import { timingSafeEqual } from "node:crypto";

import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";
import { validateM1LabDatabase } from "../../config/m1-lab-database.js";
import { appendAuditEvent } from "../audit/append-audit-event.js";
import { hashOpaqueToken, isCanonicalOpaqueToken, newOpaqueToken } from "./opaque-token.js";
import { hashPassword, normalizePassword, verifyPassword } from "./password.js";
import { decryptTotpSecret, encryptTotpSecret, newTotpSecret, totpEnrollmentUri, verifyTotpStep } from "./totp.js";

type Role = "ADMIN" | "AUTHOR" | "APPROVER";
type Transaction = Prisma.TransactionClient;
export type LabProvisioningStage =
  | "BOOTSTRAP_CHECK"
  | "USER_CREATE"
  | "INVITATION_CREATE"
  | "CHALLENGE_CREATE"
  | "REENROLL_REVOKE"
  | "REENROLL_CREATE"
  | "AUDIT_PENDING"
  | "BOOTSTRAP_MARKER"
  | "AUDIT_CONSUMED";
const enrollmentMs = 15 * 60_000;
const invitationMs = 24 * 60 * 60_000;
const adminLockMs = 15 * 60_000;

export class LabProvisioningError extends Error {
  override readonly name = "LabProvisioningError";
  constructor(readonly code: string, readonly stage?: LabProvisioningStage) { super(code); }
}

class LabStageFailure extends Error {
  override readonly name = "LabStageFailure";
  constructor(readonly stage: LabProvisioningStage, override readonly cause: unknown) {
    super("LAB_DATABASE_FAILURE");
  }
}

export interface NewIdentity {
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly password: string;
}

export interface AdminProof {
  readonly email: string;
  readonly password: string;
  readonly code: string;
}

export type ProvisioningDatabaseGuard = (source: NodeJS.ProcessEnv) => void;

type AdminCandidate = { id: string };
type EnrollmentMaterial = { userId: string; invitationToken: string; enrollmentToken: string };
type PreparedIdentity = Awaited<ReturnType<LabProvisioningService["prepareIdentity"]>>;

export class LabProvisioningService {
  constructor(private readonly prisma: PrismaClient, private readonly totpKey: Uint8Array,
    source: NodeJS.ProcessEnv, databaseGuard: ProvisioningDatabaseGuard = validateM1LabDatabase) {
    databaseGuard(source);
    if (totpKey.length !== 32) throw new LabProvisioningError("LAB_KEY_INVALID");
  }

  private async serializable<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      } catch (error) {
        if (error instanceof LabStageFailure) {
          const cause = error.cause;
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "P2034") {
            if (attempt < 2) continue;
            throw new LabProvisioningError("LAB_TRANSACTION_UNAVAILABLE");
          }
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "P2002") {
            throw new LabProvisioningError("LAB_IDENTITY_CONFLICT");
          }
          throw new LabProvisioningError("LAB_DATABASE_FAILURE", error.stage);
        }
        if (error && typeof error === "object" && "code" in error && error.code === "P2034" && attempt < 2) continue;
        if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
          throw new LabProvisioningError("LAB_IDENTITY_CONFLICT");
        }
        throw error;
      }
    }
    throw new LabProvisioningError("LAB_TRANSACTION_UNAVAILABLE");
  }

  private async stage<T>(stage: LabProvisioningStage, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof LabProvisioningError || error instanceof LabStageFailure) throw error;
      throw new LabStageFailure(stage, error);
    }
  }

  private async acquireAdvisoryLock(tx: Transaction, key: 1 | 2): Promise<void> {
    const rows = key === 1
      ? await tx.$queryRaw<Array<{ lock_acquired: number }>>`
          WITH bloqueo AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(8261, 1)
          )
          SELECT 1::int AS lock_acquired
          FROM bloqueo
        `
      : await tx.$queryRaw<Array<{ lock_acquired: number }>>`
          WITH bloqueo AS MATERIALIZED (
            SELECT pg_advisory_xact_lock(8261, 2)
          )
          SELECT 1::int AS lock_acquired
          FROM bloqueo
        `;
    if (rows.length !== 1 || rows[0]?.lock_acquired !== 1) {
      throw new Error("LAB_ADVISORY_LOCK_UNAVAILABLE");
    }
  }

  private async prepareIdentity(input: NewIdentity, expectedRole: Role) {
    const name = input.name.trim();
    const email = input.email.trim().toLowerCase();
    if (input.role !== expectedRole || name.length < 1 || name.length > 120 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      throw new LabProvisioningError("LAB_INPUT_INVALID");
    }
    const password = normalizePassword(input.password);
    const passwordHash = await hashPassword(password);
    const secret = newTotpSecret();
    const ciphertext = encryptTotpSecret(secret, this.totpKey);
    return { name, email, role: expectedRole, password, passwordHash, ciphertext, secret };
  }

  private async uniquePassword(tx: Transaction, password: string): Promise<void> {
    const existing = await tx.user.findMany({ select: { passwordHash: true } });
    for (const user of existing) {
      if (user.passwordHash && await verifyPassword(password, user.passwordHash)) {
        throw new LabProvisioningError("LAB_PASSWORD_REUSED");
      }
    }
  }

  private async adminCandidate(proof: AdminProof, now: Date): Promise<AdminCandidate> {
    const user = await this.prisma.user.findUnique({ where: { email: proof.email.trim().toLowerCase() }, select: { id: true } });
    if (!user) {
      await this.serializable(async (tx) => {
        await appendAuditEvent(tx, { actorId: null, action: "AUTH_FAILURE", objectType: "AUTH", objectId: "CLI_ADMIN",
          redactedDetails: { kind: "CLI_ADMIN", result: "REJECTED" }, occurredAt: now });
      });
      throw new LabProvisioningError("LAB_AUTH_REJECTED");
    }
    return { id: user.id };
  }

  private async adminFailure(tx: Transaction, admin: {
    id: string; failedAttempts: number; lockedUntil: Date | null;
  }, kind: "PASSWORD" | "TOTP", now: Date): Promise<void> {
    const attempts = (admin.lockedUntil && admin.lockedUntil <= now ? 0 : admin.failedAttempts) + 1;
    const lockedUntil = attempts >= 5 ? new Date(now.getTime() + adminLockMs) : null;
    await tx.user.update({ where: { id: admin.id }, data: { failedAttempts: attempts, lockedUntil } });
    if (lockedUntil) await tx.identityChallenge.updateMany({
      where: { userId: admin.id, kind: "LOGIN", consumedAt: null, revokedAt: null }, data: { revokedAt: now },
    });
    await appendAuditEvent(tx, { actorId: admin.id, action: "AUTH_FAILURE", objectType: "USER", objectId: admin.id,
      redactedDetails: { kind, attemptCount: attempts, result: lockedUntil ? "LOCKED" : "REJECTED" }, occurredAt: now });
  }

  private async authorizeAdmin(tx: Transaction, candidate: AdminCandidate, proof: AdminProof, now: Date): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${candidate.id}::uuid FOR UPDATE`;
    const admin = await tx.user.findUnique({ where: { id: candidate.id } });
    if (!admin || admin.role !== "ADMIN" || admin.status !== "ACTIVE" ||
      !admin.passwordHash || !admin.totpSecretCiphertext) {
      await appendAuditEvent(tx, { actorId: admin?.id ?? null, action: "AUTH_FAILURE", objectType: "AUTH", objectId: "CLI_ADMIN",
        redactedDetails: { kind: "CLI_ADMIN", result: "REJECTED" }, occurredAt: now });
      return false;
    }
    if (admin.lockedUntil && admin.lockedUntil > now) {
      await appendAuditEvent(tx, { actorId: admin.id, action: "AUTH_FAILURE", objectType: "USER", objectId: admin.id,
        redactedDetails: { kind: "CLI_ADMIN", result: "LOCKED" }, occurredAt: now });
      return false;
    }
    if (!await verifyPassword(proof.password, admin.passwordHash)) {
      await this.adminFailure(tx, admin, "PASSWORD", now);
      return false;
    }
    const step = verifyTotpStep(decryptTotpSecret(admin.totpSecretCiphertext, this.totpKey), proof.code, now, admin.lastTotpStep);
    if (step === null) {
      await this.adminFailure(tx, admin, "TOTP", now);
      return false;
    }
    await tx.user.update({ where: { id: admin.id }, data: {
      lastTotpStep: step, failedAttempts: 0, lockedUntil: null,
    } });
    return true;
  }

  private async createPending(tx: Transaction, prepared: PreparedIdentity,
    actorId: string | null, now: Date): Promise<EnrollmentMaterial> {
    const user = await this.stage("USER_CREATE", () => tx.user.create({ data: {
      name: prepared.name, email: prepared.email, role: prepared.role,
      passwordHash: prepared.passwordHash, totpSecretCiphertext: prepared.ciphertext,
      status: "PENDING_ENROLLMENT",
    } }));
    const invitationToken = newOpaqueToken();
    const enrollmentToken = newOpaqueToken();
    // Se conservan invitación y desafío ENROLLMENT exigidos por el esquema.
    // Sus tokens se almacenan únicamente como hash y se muestran una sola vez.
    const invitation = await this.stage("INVITATION_CREATE", () => tx.identityInvitation.create({ data: {
      userId: user.id, tokenHash: new Uint8Array(hashOpaqueToken(invitationToken)),
      expiresAt: new Date(now.getTime() + invitationMs), createdBy: actorId,
    } }));
    await this.stage("CHALLENGE_CREATE", () => tx.identityChallenge.create({ data: {
      userId: user.id, kind: "ENROLLMENT", invitationId: invitation.id,
      tokenHash: new Uint8Array(hashOpaqueToken(enrollmentToken)),
      expiresAt: new Date(now.getTime() + enrollmentMs),
    } }));
    await this.stage("AUDIT_PENDING", () => appendAuditEvent(tx, { actorId, action: "USER_CREATED_PENDING", objectType: "user", objectId: user.id,
      redactedDetails: { role: prepared.role, status: "PENDING_ENROLLMENT" }, occurredAt: now }));
    return { userId: user.id, invitationToken, enrollmentToken };
  }

  async bootstrap(input: NewIdentity, approvalReference: string, now = new Date()): Promise<EnrollmentMaterial & { otpauthUri: string }> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(approvalReference)) throw new LabProvisioningError("LAB_APPROVAL_REQUIRED");
    const prepared = await this.prepareIdentity(input, "ADMIN");
    const result = await this.serializable(async (tx) => {
      const allowed = await this.stage("BOOTSTRAP_CHECK", async () => {
        await this.acquireAdvisoryLock(tx, 1);
        return !(await tx.identityBootstrap.findUnique({ where: { id: 1 } }) || await tx.user.count() !== 0);
      });
      if (!allowed) {
        await appendAuditEvent(tx, { actorId: null, action: "BOOTSTRAP_REJECTED", objectType: "AUTH", objectId: "BOOTSTRAP",
          redactedDetails: { result: "REJECTED" }, occurredAt: now });
        return null;
      }
      const enrollment = await this.createPending(tx, prepared, null, now);
      await this.stage("BOOTSTRAP_MARKER", () => tx.identityBootstrap.create({
        data: { id: 1, consumedAt: now, initialAdminId: enrollment.userId },
      }));
      await this.stage("AUDIT_CONSUMED", () => appendAuditEvent(tx, { actorId: null, action: "BOOTSTRAP_CONSUMED", objectType: "USER", objectId: enrollment.userId,
        redactedDetails: { role: "ADMIN", result: "PENDING", reasonCode: approvalReference }, occurredAt: now }));
      return enrollment;
    });
    if (!result) throw new LabProvisioningError("LAB_BOOTSTRAP_USED");
    return { ...result, otpauthUri: totpEnrollmentUri(prepared.secret, prepared.email) };
  }

  async create(input: NewIdentity, proof: AdminProof, now = new Date()): Promise<EnrollmentMaterial & { otpauthUri: string }> {
    if (input.role !== "AUTHOR" && input.role !== "APPROVER") throw new LabProvisioningError("LAB_ROLE_INVALID");
    const prepared = await this.prepareIdentity(input, input.role);
    const candidate = await this.adminCandidate(proof, now);
    const result = await this.serializable(async (tx) => {
      await this.acquireAdvisoryLock(tx, 2);
      if (!await this.authorizeAdmin(tx, candidate, proof, now)) return null;
      if (await tx.user.count({ where: { role: input.role } }) !== 0) {
        await appendAuditEvent(tx, { actorId: candidate.id, action: "USER_CREATE_REJECTED", objectType: "USER", objectId: candidate.id,
          redactedDetails: { role: input.role, result: "REJECTED" }, occurredAt: now });
        return null;
      }
      await this.uniquePassword(tx, prepared.password);
      return this.createPending(tx, prepared, candidate.id, now);
    });
    if (!result) throw new LabProvisioningError("LAB_CREATE_REJECTED");
    return { ...result, otpauthUri: totpEnrollmentUri(prepared.secret, prepared.email) };
  }

  async reenrollAuthor(email: string, proof: AdminProof, now = new Date()):
    Promise<EnrollmentMaterial & { otpauthUri: string }> {
    const normalizedEmail = email.trim().toLowerCase();
    const target = await this.prisma.user.findUnique({
      where: { email: normalizedEmail }, select: { id: true },
    });
    if (!target) throw new LabProvisioningError("LAB_ENROLLMENT_REJECTED");
    const candidate = await this.adminCandidate(proof, now);
    const secret = newTotpSecret();
    const ciphertext = encryptTotpSecret(secret, this.totpKey);
    const invitationToken = newOpaqueToken();
    const enrollmentToken = newOpaqueToken();
    const result = await this.serializable(async (tx) => {
      await this.acquireAdvisoryLock(tx, 2);
      if (!await this.authorizeAdmin(tx, candidate, proof, now)) return null;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${target.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: target.id } });
      if (!user || user.role !== "AUTHOR" || user.status !== "PENDING_ENROLLMENT" ||
          !user.passwordHash || !user.totpSecretCiphertext) {
        await appendAuditEvent(tx, { actorId: candidate.id, action: "USER_REENROLL_REJECTED",
          objectType: "USER", objectId: target.id,
          redactedDetails: { role: "AUTHOR", result: "REJECTED" }, occurredAt: now });
        return null;
      }
      const challenge = await tx.identityChallenge.findFirst({ where: {
        userId: target.id, kind: "ENROLLMENT", consumedAt: null, revokedAt: null,
      }, include: { invitation: true } });
      if (!challenge?.invitation || challenge.invitation.consumedAt || challenge.invitation.revokedAt) {
        await appendAuditEvent(tx, { actorId: candidate.id, action: "USER_REENROLL_REJECTED",
          objectType: "USER", objectId: target.id,
          redactedDetails: { role: "AUTHOR", result: "REJECTED" }, occurredAt: now });
        return null;
      }
      const oldInvitation = challenge.invitation;
      await this.stage("REENROLL_REVOKE", async () => {
        await tx.identityChallenge.update({ where: { id: challenge.id }, data: { revokedAt: now } });
        await tx.identityInvitation.update({ where: { id: oldInvitation.id }, data: { revokedAt: now } });
      });
      const invitation = await this.stage("REENROLL_CREATE", () => tx.identityInvitation.create({ data: {
        userId: target.id, tokenHash: new Uint8Array(hashOpaqueToken(invitationToken)),
        expiresAt: new Date(now.getTime() + invitationMs), createdBy: candidate.id,
      } }));
      await this.stage("REENROLL_CREATE", () => tx.identityChallenge.create({ data: {
        userId: target.id, kind: "ENROLLMENT", invitationId: invitation.id,
        tokenHash: new Uint8Array(hashOpaqueToken(enrollmentToken)),
        expiresAt: new Date(now.getTime() + enrollmentMs),
      } }));
      await tx.user.update({ where: { id: target.id }, data: { totpSecretCiphertext: ciphertext } });
      await appendAuditEvent(tx, { actorId: candidate.id, action: "USER_REENROLL_ISSUED",
        objectType: "USER", objectId: target.id,
        redactedDetails: { role: "AUTHOR", status: "PENDING_ENROLLMENT", result: "REISSUED" }, occurredAt: now });
      return { userId: target.id, invitationToken, enrollmentToken };
    });
    if (!result) throw new LabProvisioningError("LAB_REENROLL_REJECTED");
    return { ...result, otpauthUri: totpEnrollmentUri(secret, normalizedEmail) };
  }

  async confirm(email: string, code: string, invitationToken: string, enrollmentToken: string,
    proof?: AdminProof, now = new Date()): Promise<boolean> {
    const normalizedEmail = email.trim().toLowerCase();
    const target = await this.prisma.user.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
    if (!target) throw new LabProvisioningError("LAB_ENROLLMENT_REJECTED");
    const bootstrap = await this.prisma.identityBootstrap.findUnique({ where: { id: 1 } });
    const isFirstAdmin = bootstrap?.initialAdminId === target.id;
    const candidate = isFirstAdmin ? null : proof ? await this.adminCandidate(proof, now) : null;
    if (!isFirstAdmin && !candidate) throw new LabProvisioningError("LAB_AUTH_REJECTED");
    return this.serializable(async (tx) => {
      if (candidate && !await this.authorizeAdmin(tx, candidate, proof!, now)) return false;
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${target.id}::uuid FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id: target.id } });
      const challenge = await tx.identityChallenge.findFirst({ where: {
        userId: target.id, kind: "ENROLLMENT", consumedAt: null, revokedAt: null,
      }, include: { invitation: true } });
      if (!user || user.status !== "PENDING_ENROLLMENT" || !user.passwordHash || !user.totpSecretCiphertext ||
          !challenge || challenge.expiresAt <= now || challenge.failedAttempts >= 5 ||
          !challenge.invitation || challenge.invitation.expiresAt <= now || challenge.invitation.consumedAt ||
          challenge.invitation.revokedAt) {
        await appendAuditEvent(tx, { actorId: target.id, action: "ENROLLMENT_REJECTED", objectType: "USER", objectId: target.id,
          redactedDetails: { result: "REJECTED" }, occurredAt: now });
        return false;
      }
      if (!isCanonicalOpaqueToken(invitationToken) || !isCanonicalOpaqueToken(enrollmentToken) ||
          !timingSafeEqual(hashOpaqueToken(invitationToken), challenge.invitation.tokenHash) ||
          !timingSafeEqual(hashOpaqueToken(enrollmentToken), challenge.tokenHash)) {
        const attempts = challenge.failedAttempts + 1;
        await tx.identityChallenge.update({ where: { id: challenge.id }, data: {
          failedAttempts: attempts, ...(attempts >= 5 ? { revokedAt: now } : {}),
        } });
        await appendAuditEvent(tx, { actorId: target.id, action: "ENROLLMENT_REJECTED", objectType: "USER", objectId: target.id,
          redactedDetails: { kind: "TOKEN", result: "REJECTED", attemptCount: attempts }, occurredAt: now });
        return false;
      }
      const step = verifyTotpStep(decryptTotpSecret(user.totpSecretCiphertext, this.totpKey), code, now, user.lastTotpStep);
      if (step === null) {
        const attempts = challenge.failedAttempts + 1;
        await tx.identityChallenge.update({ where: { id: challenge.id }, data: {
          failedAttempts: attempts, ...(attempts >= 5 ? { revokedAt: now } : {}),
        } });
        await appendAuditEvent(tx, { actorId: target.id, action: "ENROLLMENT_REJECTED", objectType: "USER", objectId: target.id,
          redactedDetails: { kind: "TOTP", result: "REJECTED", attemptCount: attempts }, occurredAt: now });
        return false;
      }
      await tx.identityChallenge.update({ where: { id: challenge.id }, data: { consumedAt: now } });
      await tx.identityInvitation.update({ where: { id: challenge.invitation.id }, data: { claimedAt: now, consumedAt: now } });
      await tx.user.update({ where: { id: user.id }, data: { status: "ACTIVE", lastTotpStep: step } });
      await appendAuditEvent(tx, { actorId: target.id, action: "USER_ACTIVATED", objectType: "USER", objectId: target.id,
        redactedDetails: { role: user.role, status: "ACTIVE" }, occurredAt: now });
      return true;
    });
  }
}
