import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { LabProvisioningError, LabProvisioningService, type LabProvisioningStage } from "../../src/modules/identity/lab-provisioning.js";
import { decryptTotpSecret, totpCodeForTest } from "../../src/modules/identity/totp.js";
import { verifyPassword } from "../../src/modules/identity/password.js";

const url = "postgresql://fictional:fixture-password@127.0.0.1:55432/sigae_m1_test";
const source = { SIGAE_M1_LAB: "true", DATABASE_URL: url, DIRECT_URL: url };
const key = new Uint8Array(32).fill(23);
const now = new Date("2026-10-18T12:00:00.000Z");
const adminInput = { name: "Admin ficticio", email: "admin@example.invalid", role: "ADMIN" as const,
  password: "Clave individual ADMIN 2026" };

type User = { id: string; name: string; email: string; role: string; status: string; passwordHash: string | null;
  totpSecretCiphertext: Uint8Array | null; lastTotpStep: bigint | null; lockedUntil: Date | null;
  failedAttempts: number };
type Invitation = { id: string; userId: string; tokenHash: Uint8Array; claimedAt: Date | null;
  consumedAt: Date | null; revokedAt: Date | null; expiresAt: Date };
type Challenge = { id: string; userId: string; kind: string; invitationId: string; consumedAt: Date | null;
  revokedAt: Date | null; expiresAt: Date; failedAttempts: number; tokenHash: Uint8Array };
type State = { users: User[]; invitations: Invitation[]; challenges: Challenge[];
  bootstrap: { id: number; initialAdminId: string } | null; audit: Array<{ action: string; redactedDetails: unknown }>;
  auditSeq: bigint; auditHash: Uint8Array; counter: number };

function fakeDatabase() {
  let state: State = { users: [], invitations: [], challenges: [], bootstrap: null, audit: [],
    auditSeq: 0n, auditHash: new Uint8Array(32), counter: 0 };
  let gate: Promise<unknown> = Promise.resolve();
  let failAudit = false;
  let failStage: LabProvisioningStage | null = null;
  const advisoryCalls: string[] = [];
  const operationLog: string[] = [];
  let advisoryRows: Array<{ lock_acquired: number }> = [{ lock_acquired: 1 }];
  let advisoryErrorCode: string | null = null;
  const nextId = (draft: State) => `00000000-0000-4000-8000-${String(++draft.counter).padStart(12, "0")}`;
  const fail = (stage: LabProvisioningStage) => {
    if (failStage === stage) throw new Error(`SIMULATED_${stage}`);
  };
  const makeClient = (draft: State) => ({
    user: {
      findUnique: async ({ where }: { where: { id?: string; email?: string } }) =>
        draft.users.find((item) => item.id === where.id || item.email === where.email) ?? null,
      findMany: async () => draft.users.map(({ passwordHash }) => ({ passwordHash })),
      count: async ({ where }: { where?: { role: string } } = {}) => {
        operationLog.push("user.count");
        return draft.users.filter((item) => !where || item.role === where.role).length;
      },
      create: async ({ data }: { data: Omit<User, "id" | "lastTotpStep" | "lockedUntil" | "failedAttempts"> }) => {
        operationLog.push("user.create");
        fail("USER_CREATE");
        if (draft.users.some((item) => item.email === data.email)) throw { code: "P2002" };
        const user = { ...data, id: nextId(draft), lastTotpStep: null, lockedUntil: null, failedAttempts: 0 };
        draft.users.push(user);
        return user;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
        const user = draft.users.find((item) => item.id === where.id)!;
        Object.assign(user, data);
        return user;
      },
    },
    identityBootstrap: {
      findUnique: async () => {
        operationLog.push("identityBootstrap.findUnique");
        fail("BOOTSTRAP_CHECK");
        return draft.bootstrap;
      },
      create: async ({ data }: { data: { id: number; initialAdminId: string } }) => {
        fail("BOOTSTRAP_MARKER");
        draft.bootstrap = data;
        return data;
      },
    },
    identityInvitation: {
      create: async ({ data }: { data: Omit<Invitation, "id" | "consumedAt" | "revokedAt" | "claimedAt"> }) => {
        fail("INVITATION_CREATE");
        const invitation = { ...data, id: nextId(draft), claimedAt: null, consumedAt: null, revokedAt: null };
        draft.invitations.push(invitation);
        return invitation;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Invitation> }) => {
        const item = draft.invitations.find((value) => value.id === where.id)!;
        Object.assign(item, data);
        return item;
      },
    },
    identityChallenge: {
      create: async ({ data }: { data: Omit<Challenge, "id" | "consumedAt" | "revokedAt" | "failedAttempts"> }) => {
        fail("CHALLENGE_CREATE");
        const challenge = { ...data, id: nextId(draft), consumedAt: null, revokedAt: null, failedAttempts: 0 };
        draft.challenges.push(challenge);
        return challenge;
      },
      findFirst: async ({ where }: { where: { userId: string } }) => {
        const challenge = draft.challenges.find((value) => value.userId === where.userId && !value.consumedAt && !value.revokedAt);
        return challenge ? { ...challenge, invitation: draft.invitations.find((value) => value.id === challenge.invitationId) } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Challenge> }) => {
        const item = draft.challenges.find((value) => value.id === where.id)!;
        Object.assign(item, data);
        return item;
      },
      updateMany: async ({ where, data }: { where: { userId: string; kind: string }; data: Partial<Challenge> }) => {
        for (const item of draft.challenges) {
          if (item.userId === where.userId && item.kind === where.kind && !item.consumedAt && !item.revokedAt) {
            Object.assign(item, data);
          }
        }
      },
    },
    auditEvent: { create: async ({ data }: { data: { action: string; redactedDetails: unknown } }) => {
      if (failAudit) throw new Error("SIMULATED_AUDIT_FAILURE");
      draft.audit.push({ action: data.action, redactedDetails: data.redactedDetails });
    } },
    auditChainState: { update: async ({ data }: { data: { lastSeq: bigint; lastHash: Uint8Array } }) => {
      draft.auditSeq = data.lastSeq; draft.auditHash = data.lastHash;
    } },
    $queryRaw: async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("pg_advisory_xact_lock")) {
        const key = query.match(/pg_advisory_xact_lock\(8261, ([12])\)/u)?.[1];
        if (!key) throw new Error("INVALID_ADVISORY_LOCK_QUERY");
        advisoryCalls.push(key);
        operationLog.push(`advisory:${key}`);
        fail("BOOTSTRAP_CHECK");
        if (advisoryErrorCode) throw { code: advisoryErrorCode };
        return advisoryRows;
      }
      if (query.includes("audit_chain_state")) {
        if (failStage === "AUDIT_PENDING" && draft.auditSeq === 0n) throw new Error("SIMULATED_AUDIT_PENDING");
        if (failStage === "AUDIT_CONSUMED" && draft.auditSeq > 0n) throw new Error("SIMULATED_AUDIT_CONSUMED");
        return [{ last_seq: draft.auditSeq, last_hash: draft.auditHash }];
      }
      return [];
    },
  });
  const prisma = {
    user: { findUnique: async (args: { where: { email: string } }) =>
      state.users.find((item) => item.email === args.where.email) ?? null },
    identityBootstrap: { findUnique: async () => state.bootstrap },
    $transaction: async <T>(work: (tx: ReturnType<typeof makeClient>) => Promise<T>): Promise<T> => {
      const run = gate.then(async () => {
        const draft = structuredClone(state);
        const result = await work(makeClient(draft));
        state = draft;
        return result;
      });
      gate = run.catch(() => undefined);
      return run;
    },
  } as unknown as PrismaClient;
  return {
    prisma,
    get state() { return state; },
    set failAudit(value: boolean) { failAudit = value; },
    set failStage(value: LabProvisioningStage | null) { failStage = value; },
    set advisoryRows(value: Array<{ lock_acquired: number }>) { advisoryRows = value; },
    set advisoryErrorCode(value: string | null) { advisoryErrorCode = value; },
    advisoryCalls,
    operationLog,
  };
}

function serviceFor(db: ReturnType<typeof fakeDatabase>) {
  return new LabProvisioningService(db.prisma, key, source);
}

function codeFor(user: User, at = now) {
  return totpCodeForTest(decryptTotpSecret(user.totpSecretCiphertext!, key), at);
}

async function pendingAuthor() {
  const db = fakeDatabase();
  const service = serviceFor(db);
  const adminEnrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
  await service.confirm(adminInput.email, codeFor(db.state.users[0]!), adminEnrollment.invitationToken,
    adminEnrollment.enrollmentToken, undefined, now);
  const createdAt = new Date(now.getTime() + 30_000);
  const author = await service.create({ name: "Autora ficticia", email: "author@example.invalid",
    role: "AUTHOR", password: "Clave individual AUTHOR 2026" }, {
      email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, createdAt),
    }, createdAt);
  return { db, service, author };
}

describe("CLI M1: servicio transaccional simulado, sin PostgreSQL", () => {
  it.each([
    "BOOTSTRAP_CHECK",
    "USER_CREATE",
    "INVITATION_CREATE",
    "CHALLENGE_CREATE",
    "AUDIT_PENDING",
    "BOOTSTRAP_MARKER",
    "AUDIT_CONSUMED",
  ] as const)("clasifica y revierte un fallo técnico en %s", async (stage) => {
    const db = fakeDatabase();
    db.failStage = stage;

    await expect(serviceFor(db).bootstrap(adminInput, "APROBACION_001", now))
      .rejects.toMatchObject({ code: "LAB_DATABASE_FAILURE", stage });
    expect(db.state.users).toHaveLength(0);
    expect(db.state.invitations).toHaveLength(0);
    expect(db.state.challenges).toHaveLength(0);
    expect(db.state.bootstrap).toBeNull();
    expect(db.state.audit).toHaveLength(0);
  });

  it("crea un solo ADMIN pendiente con Argon2id, secreto cifrado, marcador y auditoría", async () => {
    const db = fakeDatabase();
    const result = await serviceFor(db).bootstrap(adminInput, "APROBACION_001", now);
    const user = db.state.users[0]!;
    expect(result.userId).toBe(user.id);
    expect(result.otpauthUri).toContain("otpauth://totp/");
    expect(user.status).toBe("PENDING_ENROLLMENT");
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(adminInput.password, user.passwordHash!)).toBe(true);
    expect(user.totpSecretCiphertext).not.toBeNull();
    expect(db.state.bootstrap?.initialAdminId).toBe(user.id);
    expect(db.state.invitations[0]?.claimedAt).toBeNull();
    expect(db.state.audit.map((item) => item.action)).toEqual(["USER_CREATED_PENDING", "BOOTSTRAP_CONSUMED"]);
    expect(JSON.stringify(db.state.audit)).not.toContain(adminInput.password);
    expect(db.advisoryCalls).toEqual(["1"]);
    expect(db.operationLog.slice(0, 4)).toEqual([
      "advisory:1", "identityBootstrap.findUnique", "user.count", "user.create",
    ]);
  });

  it("rechaza segundo bootstrap y concurrencia sin duplicar ADMIN", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const outcomes = await Promise.allSettled([
      service.bootstrap(adminInput, "APROBACION_001", now),
      service.bootstrap({ ...adminInput, email: "otro@example.invalid" }, "APROBACION_001", now),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(db.state.users).toHaveLength(1);
    expect(db.state.audit.some((item) => item.action === "BOOTSTRAP_REJECTED")).toBe(true);
    await expect(service.bootstrap(adminInput, "APROBACION_001", now)).rejects.toThrow("LAB_BOOTSTRAP_USED");
  });

  it("activa solo con TOTP válido y consume el desafío y paso una vez", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const enrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    expect(await service.confirm(adminInput.email, codeFor(db.state.users[0]!), "token-invalido",
      enrollment.enrollmentToken, undefined, now)).toBe(false);
    expect(db.state.invitations[0]?.claimedAt).toBeNull();
    expect(await service.confirm(adminInput.email, "abcdef", enrollment.invitationToken, enrollment.enrollmentToken,
      undefined, now)).toBe(false);
    expect(db.state.users[0]?.status).toBe("PENDING_ENROLLMENT");
    const code = codeFor(db.state.users[0]!);
    expect(await service.confirm(adminInput.email, code, enrollment.invitationToken, enrollment.enrollmentToken,
      undefined, now)).toBe(true);
    expect(db.state.users[0]?.status).toBe("ACTIVE");
    expect(db.state.users[0]?.lastTotpStep).not.toBeNull();
    expect(db.state.challenges[0]?.consumedAt).toEqual(now);
    expect(db.state.invitations[0]?.consumedAt).toEqual(now);
    expect(db.state.invitations[0]?.claimedAt).toEqual(now);
    expect(db.state.audit.at(-1)?.action).toBe("USER_ACTIVATED");
    expect(await service.confirm(adminInput.email, code, enrollment.invitationToken, enrollment.enrollmentToken,
      undefined, now)).toBe(false);
  });

  it("dos confirmaciones concurrentes producen una sola activación", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const enrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    const code = codeFor(db.state.users[0]!);
    const results = await Promise.all([
      service.confirm(adminInput.email, code, enrollment.invitationToken, enrollment.enrollmentToken, undefined, now),
      service.confirm(adminInput.email, code, enrollment.invitationToken, enrollment.enrollmentToken, undefined, now),
    ]);
    expect(results.sort()).toEqual([false, true]);
    expect(db.state.audit.filter((event) => event.action === "USER_ACTIVATED")).toHaveLength(1);
  });

  it("restringe AUTHOR/APPROVER a ADMIN activo con MFA y contraseñas distintas", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const enrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    const adminCode = codeFor(db.state.users[0]!);
    const input = { name: "Autora ficticia", email: "author@example.invalid", role: "AUTHOR" as const,
      password: "Clave individual AUTHOR 2026" };
    await expect(service.create(input, { email: adminInput.email, password: adminInput.password, code: adminCode }, now))
      .rejects.toThrow("LAB_CREATE_REJECTED");
    expect(db.state.users).toHaveLength(1);
    await service.confirm(adminInput.email, adminCode, enrollment.invitationToken, enrollment.enrollmentToken,
      undefined, now);
    const next = new Date(now.getTime() + 30_000);
    const proof = { email: adminInput.email, password: adminInput.password, code: codeFor(db.state.users[0]!, next) };
    const created = await service.create(input, proof, next);
    expect(db.state.users[1]?.status).toBe("PENDING_ENROLLMENT");
    expect(created.otpauthUri).toContain("otpauth://totp/");
    db.state.users[1]!.status = "ACTIVE"; // Simula una cuenta AUTHOR ya enrolada.
    await expect(service.create({ ...input, email: "sinpermiso@example.invalid" }, {
      email: input.email, password: input.password, code: codeFor(db.state.users[1]!, next),
    }, next)).rejects.toThrow("LAB_CREATE_REJECTED");
    expect(db.state.users[1]?.failedAttempts).toBe(0);
    await expect(service.create({ ...input, email: "duplicado@example.invalid" }, proof, next))
      .rejects.toThrow("LAB_CREATE_REJECTED");
    const later = new Date(next.getTime() + 30_000);
    const laterProof = { ...proof, code: codeFor(db.state.users[0]!, later) };
    await expect(service.create({ ...input, role: "APPROVER", email: "approver@example.invalid",
      password: adminInput.password }, laterProof, later)).rejects.toThrow("LAB_PASSWORD_REUSED");
    const approver = await service.create({ ...input, role: "APPROVER", email: "approver@example.invalid",
      password: "Clave individual APPROVER 2026" }, laterProof, later);
    expect(approver.userId).toBe(db.state.users[2]?.id);
    expect(db.advisoryCalls).toEqual(["1", "2", "2", "2", "2", "2", "2"]);
  });

  it("re-emite de forma atómica el enrolamiento de AUTHOR sin cambiar su identidad", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const adminEnrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), adminEnrollment.invitationToken,
      adminEnrollment.enrollmentToken, undefined, now);
    const authorTime = new Date(now.getTime() + 30_000);
    const adminProof = { email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, authorTime) };
    const author = await service.create({ name: "Autora ficticia", email: "author@example.invalid",
      role: "AUTHOR", password: "Clave individual AUTHOR 2026" }, adminProof, authorTime);
    const oldUserId = author.userId;
    const oldInvitation = author.invitationToken;
    const oldEnrollment = author.enrollmentToken;
    const reenrollTime = new Date(now.getTime() + 60_000);
    const replacement = await service.reenrollAuthor("author@example.invalid", {
      email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, reenrollTime),
    }, reenrollTime);

    expect(replacement.userId).toBe(oldUserId);
    expect(replacement.invitationToken).not.toBe(oldInvitation);
    expect(replacement.enrollmentToken).not.toBe(oldEnrollment);
    expect(replacement.otpauthUri).not.toBe(author.otpauthUri);
    expect(db.state.users[1]?.role).toBe("AUTHOR");
    expect(db.state.users[1]?.status).toBe("PENDING_ENROLLMENT");
    expect(db.state.users[1]?.passwordHash).toBeTruthy();
    expect(db.state.invitations.find((item) => item.userId === oldUserId)?.revokedAt).toEqual(reenrollTime);
    expect(db.state.challenges.find((item) => item.userId === oldUserId)?.revokedAt).toEqual(reenrollTime);
    expect(db.state.audit.at(-1)?.action).toBe("USER_REENROLL_ISSUED");
    expect(JSON.stringify(db.state.audit)).not.toContain(oldInvitation);
    expect(JSON.stringify(db.state.audit)).not.toContain(oldEnrollment);

    const invalidatedMaterial = [
      [oldInvitation, replacement.enrollmentToken],
      [replacement.invitationToken, oldEnrollment],
      [oldInvitation, oldEnrollment],
    ] as const;
    for (const [index, [invitationToken, enrollmentToken]] of invalidatedMaterial.entries()) {
      const attemptTime = new Date(now.getTime() + 90_000 + index * 30_000);
      expect(await service.confirm("author@example.invalid", codeFor(db.state.users[1]!, attemptTime),
        invitationToken, enrollmentToken, {
          email: adminInput.email, password: adminInput.password,
          code: codeFor(db.state.users[0]!, attemptTime),
        }, attemptTime)).toBe(false);
    }
    const activationTime = new Date(now.getTime() + 180_000);
    expect(await service.confirm("author@example.invalid", codeFor(db.state.users[1]!, activationTime),
      replacement.invitationToken, replacement.enrollmentToken, {
        email: adminInput.email, password: adminInput.password,
        code: codeFor(db.state.users[0]!, activationTime),
      }, activationTime)).toBe(true);
    expect(db.state.users[1]?.status).toBe("ACTIVE");
  });

  it("rechaza re-enrolamiento sin ADMIN MFA, para cuenta activa o para APPROVER", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const adminEnrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), adminEnrollment.invitationToken,
      adminEnrollment.enrollmentToken, undefined, now);
    const authorTime = new Date(now.getTime() + 30_000);
    const author = await service.create({ name: "Autora ficticia", email: "author@example.invalid",
      role: "AUTHOR", password: "Clave individual AUTHOR 2026" }, {
        email: adminInput.email, password: adminInput.password,
        code: codeFor(db.state.users[0]!, authorTime),
      }, authorTime);
    const authorBeforeFailure = { ...db.state.users[1]!, totpSecretCiphertext: Buffer.from(db.state.users[1]!.totpSecretCiphertext!) };
    const invitationBeforeFailure = structuredClone(db.state.invitations.at(-1));
    const challengeBeforeFailure = structuredClone(db.state.challenges.at(-1));
    await expect(service.reenrollAuthor("author@example.invalid", {
      email: adminInput.email, password: adminInput.password, code: "000000",
    }, new Date(now.getTime() + 60_000))).rejects.toMatchObject({ code: "LAB_REENROLL_REJECTED" });
    expect(Buffer.from(db.state.users[1]!.totpSecretCiphertext!).equals(authorBeforeFailure.totpSecretCiphertext)).toBe(true);
    expect(db.state.users[1]).toMatchObject({
      id: authorBeforeFailure.id, role: authorBeforeFailure.role, status: authorBeforeFailure.status,
      passwordHash: authorBeforeFailure.passwordHash,
    });
    expect(db.state.invitations.at(-1)).toEqual(invitationBeforeFailure);
    expect(db.state.challenges.at(-1)).toEqual(challengeBeforeFailure);
    db.state.users[1]!.status = "ACTIVE";
    await expect(service.reenrollAuthor("author@example.invalid", {
      email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, new Date(now.getTime() + 90_000)),
    }, new Date(now.getTime() + 90_000))).rejects.toMatchObject({ code: "LAB_REENROLL_REJECTED" });
    const approver = await service.create({ name: "Aprobadora ficticia", email: "approver@example.invalid",
      role: "APPROVER", password: "Clave individual APPROVER 2026" }, {
        email: adminInput.email, password: adminInput.password,
        code: codeFor(db.state.users[0]!, new Date(now.getTime() + 120_000)),
      }, new Date(now.getTime() + 120_000));
    await expect(service.reenrollAuthor("approver@example.invalid", {
      email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, new Date(now.getTime() + 150_000)),
    }, new Date(now.getTime() + 150_000))).rejects.toMatchObject({ code: "LAB_REENROLL_REJECTED" });
    expect(approver.userId).toBe(db.state.users[2]?.id);
    expect(author.userId).toBe(db.state.users[1]?.id);
  });

  it("rechaza TOTP ADMIN reutilizado, evita doble re-emisión y revierte ante fallo de auditoría", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const adminEnrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), adminEnrollment.invitationToken,
      adminEnrollment.enrollmentToken, undefined, now);
    const createTime = new Date(now.getTime() + 30_000);
    await service.create({ name: "Autora ficticia", email: "author@example.invalid",
      role: "AUTHOR", password: "Clave individual AUTHOR 2026" }, {
        email: adminInput.email, password: adminInput.password,
        code: codeFor(db.state.users[0]!, createTime),
      }, createTime);
    const reusedProof = { email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, createTime) };
    await expect(service.reenrollAuthor("author@example.invalid", reusedProof, createTime))
      .rejects.toMatchObject({ code: "LAB_REENROLL_REJECTED" });
    const concurrentTime = new Date(now.getTime() + 60_000);
    const proof = { email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, concurrentTime) };
    const outcomes = await Promise.allSettled([
      service.reenrollAuthor("author@example.invalid", proof, concurrentTime),
      service.reenrollAuthor("author@example.invalid", proof, concurrentTime),
    ]);
    expect(outcomes.filter((item) => item.status === "fulfilled")).toHaveLength(1);
    expect(db.state.audit.filter((event) => event.action === "USER_REENROLL_ISSUED")).toHaveLength(1);
    const stableInvitation = db.state.invitations.at(-1)?.id;
    const stableChallenge = db.state.challenges.at(-1)?.id;
    const stableUser = { ...db.state.users[1]!, totpSecretCiphertext: Buffer.from(db.state.users[1]!.totpSecretCiphertext!) };
    const stableInvitationState = structuredClone(db.state.invitations.at(-1));
    const stableChallengeState = structuredClone(db.state.challenges.at(-1));
    const rollbackTime = new Date(now.getTime() + 90_000);
    db.failAudit = true;
    await expect(service.reenrollAuthor("author@example.invalid", {
      email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, rollbackTime),
    }, rollbackTime)).rejects.toThrow("SIMULATED_AUDIT_FAILURE");
    expect(db.state.invitations.at(-1)?.id).toBe(stableInvitation);
    expect(db.state.challenges.at(-1)?.id).toBe(stableChallenge);
    expect(Buffer.from(db.state.users[1]!.totpSecretCiphertext!).equals(stableUser.totpSecretCiphertext)).toBe(true);
    expect(db.state.users[1]).toMatchObject({
      id: stableUser.id, role: stableUser.role, status: stableUser.status,
      passwordHash: stableUser.passwordHash,
    });
    expect(db.state.invitations.at(-1)).toEqual(stableInvitationState);
    expect(db.state.challenges.at(-1)).toEqual(stableChallengeState);
  });

  it.each([
    ["desafío expirado", (db: ReturnType<typeof fakeDatabase>) => {
      db.state.challenges.at(-1)!.expiresAt = new Date(now.getTime() - 1);
    }],
    ["desafío agotado", (db: ReturnType<typeof fakeDatabase>) => {
      db.state.challenges.at(-1)!.failedAttempts = 5;
    }],
    ["invitación expirada", (db: ReturnType<typeof fakeDatabase>) => {
      db.state.invitations.at(-1)!.expiresAt = new Date(now.getTime() - 1);
    }],
  ])("recupera AUTHOR pendiente cuando el material anterior está %s", async (_label, invalidate) => {
    const { db, service, author } = await pendingAuthor();
    invalidate(db);
    const reenrollTime = new Date(now.getTime() + 60_000);
    const replacement = await service.reenrollAuthor("author@example.invalid", {
      email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, reenrollTime),
    }, reenrollTime);
    expect(replacement.userId).toBe(author.userId);
    expect(db.state.users[1]?.status).toBe("PENDING_ENROLLMENT");
    expect(db.state.audit.at(-1)?.action).toBe("USER_REENROLL_ISSUED");
  });

  it.each(["ausente", "consumido", "revocado"] as const)(
    "rechaza recuperación si el desafío anterior está %s sin mutar AUTHOR",
    async (state) => {
      const { db, service, author } = await pendingAuthor();
      const user = db.state.users[1]!;
      const oldCiphertext = Buffer.from(user.totpSecretCiphertext!);
      const oldPassword = user.passwordHash;
      const invitation = db.state.invitations.find((item) => item.userId === author.userId)!;
      const challenge = db.state.challenges.find((item) => item.userId === author.userId)!;
      if (state === "ausente") db.state.challenges.splice(db.state.challenges.indexOf(challenge), 1);
      if (state === "consumido") challenge.consumedAt = now;
      if (state === "revocado") challenge.revokedAt = now;
      const beforeInvitation = structuredClone(invitation);
      const beforeChallenge = structuredClone(challenge);
      await expect(service.reenrollAuthor("author@example.invalid", {
        email: adminInput.email, password: adminInput.password,
        code: codeFor(db.state.users[0]!, new Date(now.getTime() + 60_000)),
      }, new Date(now.getTime() + 60_000))).rejects.toMatchObject({ code: "LAB_REENROLL_REJECTED" });
      expect(Buffer.from(user.totpSecretCiphertext!).equals(oldCiphertext)).toBe(true);
      expect(user.passwordHash).toBe(oldPassword);
      expect(user.role).toBe("AUTHOR");
      expect(user.status).toBe("PENDING_ENROLLMENT");
      expect(user.id).toBe(author.userId);
      expect(invitation).toEqual(beforeInvitation);
      if (state === "ausente") {
        expect(db.state.challenges.some((item) => item.id === beforeChallenge.id)).toBe(false);
      } else {
        expect(challenge).toEqual(beforeChallenge);
      }
    },
  );

  it.each([
    { rows: [] },
    { rows: [{ lock_acquired: 0 }] },
    { rows: [{ lock_acquired: 1 }, { lock_acquired: 1 }] },
  ] as Array<{ rows: Array<{ lock_acquired: number }> }>)("rechaza respuesta advisory inválida: %j", async ({ rows }) => {
    const db = fakeDatabase();
    db.advisoryRows = rows;

    await expect(serviceFor(db).bootstrap(adminInput, "APROBACION_001", now))
      .rejects.toMatchObject({ code: "LAB_DATABASE_FAILURE", stage: "BOOTSTRAP_CHECK" });
    expect(db.state.users).toHaveLength(0);
    expect(db.state.bootstrap).toBeNull();
  });

  it("conserva la clasificación de P2002 del advisory lock", async () => {
    const db = fakeDatabase();
    db.advisoryErrorCode = "P2002";

    await expect(serviceFor(db).bootstrap(adminInput, "APROBACION_001", now))
      .rejects.toMatchObject({ code: "LAB_IDENTITY_CONFLICT" });
    expect(db.state.users).toHaveLength(0);
  });

  it("conserva los reintentos y la clasificación de P2034 del advisory lock", async () => {
    const db = fakeDatabase();
    db.advisoryErrorCode = "P2034";

    await expect(serviceFor(db).bootstrap(adminInput, "APROBACION_001", now))
      .rejects.toMatchObject({ code: "LAB_TRANSACTION_UNAVAILABLE" });
    expect(db.advisoryCalls).toEqual(["1", "1", "1"]);
    expect(db.state.users).toHaveLength(0);
  });

  it("rechaza destino remoto y revierte creación si falla la auditoría", async () => {
    const db = fakeDatabase();
    expect(() => new LabProvisioningService(db.prisma, key, { ...source,
      DIRECT_URL: "postgresql://fictional:fixture-password@remote.invalid:55432/sigae_m1_test" })).toThrow();
    db.failAudit = true;
    await expect(serviceFor(db).bootstrap(adminInput, "APROBACION_001", now))
      .rejects.toMatchObject({ code: "LAB_DATABASE_FAILURE", stage: "AUDIT_PENDING" });
    expect(db.state.users).toHaveLength(0);
    expect(db.state.bootstrap).toBeNull();
    db.failAudit = false;
    const service = serviceFor(db);
    const enrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    db.failAudit = true;
    await expect(service.confirm(adminInput.email, codeFor(db.state.users[0]!), enrollment.invitationToken,
      enrollment.enrollmentToken, undefined, now))
      .rejects.toThrow("SIMULATED_AUDIT_FAILURE");
    expect(db.state.users[0]?.status).toBe("PENDING_ENROLLMENT");
    expect(db.state.challenges[0]?.consumedAt).toBeNull();
  });

  it("activa AUTHOR y APPROVER solo tras sus TOTP individuales y MFA reciente del ADMIN", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const adminEnrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), adminEnrollment.invitationToken,
      adminEnrollment.enrollmentToken, undefined, now);
    const proofAt = (at: Date) => ({ email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, at) });
    const authorTime = new Date(now.getTime() + 30_000);
    const author = await service.create({ name: "Autora ficticia", email: "author@example.invalid", role: "AUTHOR",
      password: "Clave individual AUTHOR 2026" }, proofAt(authorTime), authorTime);
    const authorConfirm = new Date(now.getTime() + 60_000);
    expect(await service.confirm("author@example.invalid", codeFor(db.state.users[1]!, authorConfirm),
      author.invitationToken, author.enrollmentToken, proofAt(authorConfirm), authorConfirm)).toBe(true);
    const approverTime = new Date(now.getTime() + 90_000);
    const approver = await service.create({ name: "Aprobadora ficticia", email: "approver@example.invalid", role: "APPROVER",
      password: "Clave individual APPROVER 2026" }, proofAt(approverTime), approverTime);
    const approverConfirm = new Date(now.getTime() + 120_000);
    expect(await service.confirm("approver@example.invalid", codeFor(db.state.users[2]!, approverConfirm),
      approver.invitationToken, approver.enrollmentToken, proofAt(approverConfirm), approverConfirm)).toBe(true);
    expect(db.state.users.map((user) => user.status)).toEqual(["ACTIVE", "ACTIVE", "ACTIVE"]);
    expect(db.state.audit.filter((event) => event.action === "USER_ACTIVATED")).toHaveLength(3);
  });

  it("no incrementa los intentos de AUTHOR cuando falla la autorización ADMIN en confirm", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const adminEnrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), adminEnrollment.invitationToken,
      adminEnrollment.enrollmentToken, undefined, now);
    const proofAt = new Date(now.getTime() + 30_000);
    const author = await service.create({ name: "Autora ficticia", email: "author@example.invalid", role: "AUTHOR",
      password: "Clave individual AUTHOR 2026" }, {
      email: adminInput.email, password: adminInput.password, code: codeFor(db.state.users[0]!, proofAt),
    }, proofAt);
    const challenge = db.state.challenges.find((item) => item.userId === author.userId)!;
    const authorAttempts = challenge.failedAttempts;
    const adminFailure = await service.confirm("author@example.invalid", codeFor(db.state.users[1]!, proofAt),
      author.invitationToken, author.enrollmentToken, {
        email: adminInput.email, password: adminInput.password, code: "abcdef",
      }, proofAt);

    expect(adminFailure).toBe(false);
    expect(challenge.failedAttempts).toBe(authorAttempts);
    expect(db.state.users[0]?.failedAttempts).toBe(1);
  });

  it("acumula contraseña y TOTP fallidos, bloquea 15 minutos y recupera al vencer", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const enrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), enrollment.invitationToken,
      enrollment.enrollmentToken, undefined, now);
    const input = { name: "Autora ficticia", email: "author@example.invalid", role: "AUTHOR" as const,
      password: "Clave individual AUTHOR 2026" };
    const attemptAt = new Date(now.getTime() + 30_000);
    const code = codeFor(db.state.users[0]!, attemptAt);
    const wrongPassword = "Contraseña ficticia incorrecta 2026";
    const attempt = async (password: string, totp: string, at = attemptAt) =>
      expect(service.create(input, { email: adminInput.email, password, code: totp }, at))
        .rejects.toThrow("LAB_CREATE_REJECTED");

    await attempt(wrongPassword, code);
    await attempt(wrongPassword, code);
    expect(db.state.users[0]?.failedAttempts).toBe(2);
    // Servicio nuevo, mismo estado persistente simulado: reiniciar CLI no reinicia la cuenta.
    const restarted = serviceFor(db);
    for (let count = 3; count <= 5; count++) {
      await expect(restarted.create(input, { email: adminInput.email, password: adminInput.password,
        code: "abcdef" }, attemptAt)).rejects.toThrow("LAB_CREATE_REJECTED");
      expect(db.state.users[0]?.failedAttempts).toBe(count);
    }
    const lockedUntil = new Date(attemptAt.getTime() + 15 * 60_000);
    expect(db.state.users[0]?.lockedUntil).toEqual(lockedUntil);
    const lastStep = db.state.users[0]?.lastTotpStep;
    expect(db.state.audit.at(-1)).toMatchObject({ action: "AUTH_FAILURE",
      redactedDetails: { kind: "TOTP", attemptCount: 5, result: "LOCKED" } });
    expect(db.state.audit.filter((event) => event.action === "AUTH_FAILURE")).toHaveLength(5);
    expect(JSON.stringify(db.state.audit)).not.toContain(wrongPassword);
    expect(JSON.stringify(db.state.audit)).not.toContain("abcdef");

    await attempt(adminInput.password, code, new Date(lockedUntil.getTime() - 1));
    expect(db.state.users[0]?.failedAttempts).toBe(5);
    expect(db.state.users[0]?.lockedUntil).toEqual(lockedUntil);
    expect(db.state.users[0]?.lastTotpStep).toBe(lastStep);

    await attempt(wrongPassword, code, lockedUntil);
    expect(db.state.users[0]?.failedAttempts).toBe(1);
    expect(db.state.users[0]?.lockedUntil).toBeNull();
    const afterExpiry = new Date(lockedUntil.getTime() + 30_000);
    const created = await restarted.create(input, { email: adminInput.email, password: adminInput.password,
      code: codeFor(db.state.users[0]!, afterExpiry) }, afterExpiry);
    expect(created.userId).toBe(db.state.users[1]?.id);
    expect(db.state.users[0]?.failedAttempts).toBe(0);
    expect(db.state.users[0]?.lastTotpStep).not.toBe(lastStep);
  });

  it("rechaza la reutilización del paso TOTP y no bloquea identidades inexistentes", async () => {
    const db = fakeDatabase();
    const service = serviceFor(db);
    const enrollment = await service.bootstrap(adminInput, "APROBACION_001", now);
    await service.confirm(adminInput.email, codeFor(db.state.users[0]!), enrollment.invitationToken,
      enrollment.enrollmentToken, undefined, now);
    const at = new Date(now.getTime() + 30_000);
    const proof = { email: adminInput.email, password: adminInput.password, code: codeFor(db.state.users[0]!, at) };
    await service.create({ name: "Autora", email: "author@example.invalid", role: "AUTHOR",
      password: "Clave individual AUTHOR 2026" }, proof, at);
    const step = db.state.users[0]?.lastTotpStep;
    await expect(service.create({ name: "Aprobadora", email: "approver@example.invalid", role: "APPROVER",
      password: "Clave individual APPROVER 2026" }, proof, at)).rejects.toThrow("LAB_CREATE_REJECTED");
    expect(db.state.users[0]?.lastTotpStep).toBe(step);
    expect(db.state.users[0]?.failedAttempts).toBe(1);
    expect(db.state.audit.at(-1)).toMatchObject({ action: "AUTH_FAILURE",
      redactedDetails: { kind: "TOTP", result: "REJECTED" } });
    await expect(service.create({ name: "Aprobadora", email: "approver@example.invalid", role: "APPROVER",
      password: "Clave individual APPROVER 2026" }, { ...proof, email: "unknown@example.invalid" }, at))
      .rejects.toThrow("LAB_AUTH_REJECTED");
    expect(db.state.users[0]?.failedAttempts).toBe(1);
    expect(db.state.audit.at(-1)).toMatchObject({ action: "AUTH_FAILURE",
      redactedDetails: { kind: "CLI_ADMIN", result: "REJECTED" } });
  });
});
