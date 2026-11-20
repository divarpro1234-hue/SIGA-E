import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { appendAuditEvent } from "../../src/modules/audit/append-audit-event.js";
import { hashPassword } from "../../src/modules/identity/password.js";
import {
  decryptTotpSecret, encryptTotpSecret, newTotpSecret, totpCodeForTest, verifyTotpStep,
} from "../../src/modules/identity/totp.js";
import {
  PrismaTotpReconfigurationService,
  type TotpReconfigurationService,
} from "../../src/modules/identity/totp-reconfiguration.js";

const now = new Date("2026-10-19T12:00:00.000Z");
const userId = "00000000-0000-4000-8000-000000000001";
const otherUserId = "00000000-0000-4000-8000-000000000002";
const key = new Uint8Array(32).fill(17);
const source = { SIGAE_M1_LAB: "true", DATABASE_URL: "******127.0.0.1:55432/sigae_m1_test",
  DIRECT_URL: "******127.0.0.1:55432/sigae_m1_test" };

type User = {
  id: string; name: string; email: string; role: "AUTHOR" | "APPROVER" | "ADMIN";
  status: "ACTIVE" | "DISABLED";
  passwordHash: string; totpSecretCiphertext: Uint8Array; failedAttempts: number;
  lockedUntil: Date | null; lastTotpStep: bigint | null;
};
type Challenge = {
  id: string; userId: string; kind: "TOTP_RECONFIGURE"; tokenHash: Uint8Array;
  pendingTotpCiphertext: Uint8Array | null; expiresAt: Date; failedAttempts: number;
  consumedAt: Date | null; revokedAt: Date | null;
};
type Session = { userId: string; tokenHash: Uint8Array; revokedAt: Date | null };
type State = {
  users: User[]; challenges: Challenge[]; sessions: Session[];
  audit: Array<{ action: string; details: Record<string, unknown> }>;
  auditSeq: bigint; auditHash: Uint8Array; nextId: number;
};

async function fakeDatabase() {
  const passwordHash = await hashPassword("Clave ficticia AUTHOR 2026");
  const oldSecret = newTotpSecret();
  let state: State = {
    users: [
      { id: userId, name: "Autor ficticio", email: "author@example.invalid", role: "AUTHOR",
        status: "ACTIVE", passwordHash, totpSecretCiphertext: encryptTotpSecret(oldSecret, key),
        failedAttempts: 0, lockedUntil: null, lastTotpStep: null },
    ],
    challenges: [], sessions: [
      { userId, tokenHash: new Uint8Array(32).fill(1), revokedAt: null },
      { userId: otherUserId, tokenHash: new Uint8Array(32).fill(2), revokedAt: null },
    ],
    audit: [], auditSeq: 0n, auditHash: new Uint8Array(32), nextId: 1,
  };
  let gate: Promise<unknown> = Promise.resolve();
  let failAudit = false;

  const client = (draft: State) => ({
    user: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        draft.users.find((item) => item.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<User> }) => {
        const user = draft.users.find((item) => item.id === where.id)!;
        Object.assign(user, data);
        return user;
      },
    },
    identityChallenge: {
      findFirst: async ({ where }: { where: { userId: string } }) =>
        draft.challenges.find((item) => item.userId === where.userId &&
          !item.consumedAt && !item.revokedAt) ?? null,
      findUnique: async ({ where }: { where: { id?: string; tokenHash?: Uint8Array } }) =>
        draft.challenges.find((item) => where.id === item.id ||
          (where.tokenHash && Buffer.from(where.tokenHash).equals(Buffer.from(item.tokenHash)))) ?? null,
      create: async ({ data }: { data: Omit<Challenge, "id" | "failedAttempts" | "consumedAt" | "revokedAt"> }) => {
        const challenge = { ...data, id: `challenge-${draft.nextId++}`, failedAttempts: 0,
          consumedAt: null, revokedAt: null };
        draft.challenges.push(challenge);
        return challenge;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<Challenge> }) => {
        const challenge = draft.challenges.find((item) => item.id === where.id)!;
        Object.assign(challenge, data);
        return challenge;
      },
    },
    session: {
      updateMany: async ({ where, data }: { where: { userId: string; revokedAt: null }; data: { revokedAt: Date } }) => {
        let count = 0;
        for (const session of draft.sessions) {
          if (session.userId === where.userId && session.revokedAt === where.revokedAt) {
            session.revokedAt = data.revokedAt;
            count++;
          }
        }
        return { count };
      },
    },
    auditEvent: {
      create: async ({ data }: { data: { action: string; redactedDetails: Record<string, unknown> } }) => {
        if (failAudit) throw new Error("SIMULATED_AUDIT_FAILURE");
        draft.audit.push({ action: data.action, details: data.redactedDetails });
      },
    },
    auditChainState: {
      update: async ({ data }: { data: { lastSeq: bigint; lastHash: Uint8Array } }) => {
        draft.auditSeq = data.lastSeq;
        draft.auditHash = data.lastHash;
      },
    },
    $queryRaw: async (parts: TemplateStringsArray) => {
      const query = parts.join("");
      if (query.includes("identity_rate_limits")) return [{ attempt_count: 1 }];
      if (query.includes("audit_chain_state")) return [{ last_seq: draft.auditSeq, last_hash: draft.auditHash }];
      return [{ id: userId }];
    },
  });

  const prisma = {
    $transaction: async <T>(work: (tx: ReturnType<typeof client>) => Promise<T>): Promise<T> => {
      const run = gate.then(async () => {
        const draft = structuredClone(state) as State;
        const result = await work(client(draft));
        state = draft;
        return result;
      });
      gate = run.catch(() => undefined);
      return run;
    },
  } as unknown as PrismaClient;
  return {
    prisma, get state() { return state; }, oldSecret,
    set failAudit(value: boolean) { failAudit = value; },
  };
}

function serviceFor(prisma: PrismaClient): TotpReconfigurationService {
  return new PrismaTotpReconfigurationService(prisma, key, new Uint8Array(32).fill(29));
}

describe("servicio de reconfiguración TOTP M1", () => {
  it("conserva el secreto activo al iniciar, confirma el nuevo y revoca solo sesiones propias", async () => {
    const db = await fakeDatabase();
    const service = serviceFor(db.prisma);
    const oldCiphertext = db.state.users[0]!.totpSecretCiphertext;
    const oldPassword = db.state.users[0]!.passwordHash;
    const oldCode = totpCodeForTest(db.oldSecret, now);
    const started = await service.start(userId, "Clave ficticia AUTHOR 2026", oldCode, "test", now);
    const challenge = db.state.challenges[0]!;
    const newSecret = decryptTotpSecret(challenge.pendingTotpCiphertext!, key);

    expect(db.state.users[0]!.totpSecretCiphertext).toEqual(oldCiphertext);
    expect(db.state.users[0]!.passwordHash).toBe(oldPassword);
    await service.confirm(userId, started.reconfigureToken, totpCodeForTest(newSecret, now), now);

    expect(db.state.users[0]!.totpSecretCiphertext).not.toEqual(oldCiphertext);
    expect(db.state.users[0]!.status).toBe("ACTIVE");
    expect(db.state.challenges[0]!.consumedAt).toEqual(now);
    expect(db.state.challenges[0]!.pendingTotpCiphertext).toBeNull();
    expect(db.state.sessions[0]!.revokedAt).toEqual(now);
    expect(db.state.sessions[1]!.revokedAt).toBeNull();
    const later = new Date(now.getTime() + 30_000);
    const oldCodeLater = totpCodeForTest(db.oldSecret, later);
    const newCodeLater = totpCodeForTest(newSecret, later);
    expect(verifyTotpStep(db.oldSecret, oldCodeLater, later, null)).not.toBeNull();
    expect(verifyTotpStep(newSecret, oldCodeLater, later, null)).toBeNull();
    expect(verifyTotpStep(newSecret, newCodeLater, later, null)).not.toBeNull();
    expect(db.state.audit.map((event) => event.action)).toEqual(["TOTP_RECONFIGURE_STARTED", "TOTP_RECONFIGURED"]);
    expect(JSON.stringify(db.state.audit)).not.toContain(started.reconfigureToken);
    expect(JSON.stringify(db.state.audit)).not.toContain(started.otpauthUri);
  });

  it("no sustituye el secreto ni consume el desafío con un código nuevo inválido", async () => {
    const db = await fakeDatabase();
    const service = serviceFor(db.prisma);
    const oldCiphertext = db.state.users[0]!.totpSecretCiphertext;
    const started = await service.start(userId, "Clave ficticia AUTHOR 2026",
      totpCodeForTest(db.oldSecret, now), "test", now);

    await expect(service.confirm(userId, started.reconfigureToken, "000000", now))
      .rejects.toMatchObject({ code: "TOTP_RECONFIGURE_INVALID" });
    expect(db.state.users[0]!.totpSecretCiphertext).toEqual(oldCiphertext);
    expect(db.state.challenges[0]!.consumedAt).toBeNull();
    expect(db.state.challenges[0]!.failedAttempts).toBe(1);
  });

  it("rechaza un segundo inicio abierto y el reuso del desafío consumido", async () => {
    const db = await fakeDatabase();
    const service = serviceFor(db.prisma);
    const code = totpCodeForTest(db.oldSecret, now);
    const started = await service.start(userId, "Clave ficticia AUTHOR 2026", code, "test", now);
    const nextTime = new Date(now.getTime() + 30_000);
    await expect(service.start(userId, "Clave ficticia AUTHOR 2026",
      totpCodeForTest(db.oldSecret, nextTime), "test", nextTime))
      .rejects.toMatchObject({ code: "TOTP_RECONFIGURE_CONFLICT" });
    const pending = decryptTotpSecret(db.state.challenges[0]!.pendingTotpCiphertext!, key);
    await service.confirm(userId, started.reconfigureToken, totpCodeForTest(pending, now), now);
    await expect(service.confirm(userId, started.reconfigureToken, totpCodeForTest(pending, now), now))
      .rejects.toMatchObject({ code: "TOTP_RECONFIGURE_INVALID" });
  });

  it("revoca un desafío pendiente expirado antes de crear el siguiente", async () => {
    const db = await fakeDatabase();
    const service = serviceFor(db.prisma);
    const started = await service.start(userId, "Clave ficticia AUTHOR 2026",
      totpCodeForTest(db.oldSecret, now), "test", now);
    db.state.challenges[0]!.expiresAt = new Date(now.getTime() - 1);
    const nextTime = new Date(now.getTime() + 30_000);
    const next = await service.start(userId, "Clave ficticia AUTHOR 2026",
      totpCodeForTest(db.oldSecret, nextTime), "test", nextTime);

    expect(next.reconfigureToken).not.toBe(started.reconfigureToken);
    expect(db.state.challenges[0]!.revokedAt).toEqual(nextTime);
    expect(db.state.challenges).toHaveLength(2);
  });

  it("rechaza confirmar si la cuenta deja de estar ACTIVE", async () => {
    const db = await fakeDatabase();
    const service = serviceFor(db.prisma);
    const started = await service.start(userId, "Clave ficticia AUTHOR 2026",
      totpCodeForTest(db.oldSecret, now), "test", now);
    const ciphertext = db.state.users[0]!.totpSecretCiphertext;
    db.state.users[0]!.status = "DISABLED";
    db.state.users[0]!.lockedUntil = null;

    await expect(service.confirm(userId, started.reconfigureToken, "123456", now))
      .rejects.toMatchObject({ code: "TOTP_RECONFIGURE_INVALID" });
    expect(db.state.users[0]!.totpSecretCiphertext).toEqual(ciphertext);
    expect(db.state.challenges[0]!.consumedAt).toBeNull();
    expect(db.state.sessions[0]!.revokedAt).toBeNull();
    expect(db.state.audit.at(-1)).toMatchObject({ action: "TOTP_RECONFIGURE_REJECTED" });
  });

  it("revierte el inicio completo si falla la auditoría", async () => {
    const db = await fakeDatabase();
    const service = serviceFor(db.prisma);
    const oldCiphertext = db.state.users[0]!.totpSecretCiphertext;
    db.failAudit = true;

    await expect(service.start(userId, "Clave ficticia AUTHOR 2026",
      totpCodeForTest(db.oldSecret, now), "test", now)).rejects.toThrow("SIMULATED_AUDIT_FAILURE");
    expect(db.state.users[0]!.totpSecretCiphertext).toEqual(oldCiphertext);
    expect(db.state.users[0]!.lastTotpStep).toBeNull();
    expect(db.state.challenges).toHaveLength(0);
    expect(db.state.audit).toHaveLength(0);
  });
});
