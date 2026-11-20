import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { PrismaLoginService } from "../../src/modules/identity/login-service.js";
import { hashPassword } from "../../src/modules/identity/password.js";
import { encryptTotpSecret, totpCodeForTest } from "../../src/modules/identity/totp.js";

type TestUser = {
  id: string;
  name: string;
  email: string;
  role: "ADMIN";
  status: "ACTIVE";
  passwordHash: string;
  totpSecretCiphertext: Uint8Array;
  failedAttempts: number;
  lockedUntil: Date | null;
  lastTotpStep: bigint | null;
};

type TestChallenge = {
  id: string;
  userId: string;
  kind: string;
  tokenHash: Uint8Array;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  failedAttempts: number;
};

function fakePrisma(user: TestUser | null) {
  let auditSequence = 0n;
  let auditHash = new Uint8Array(32);
  let rateAttempts = 0;
  let challengeSequence = 0;
  const challenges: TestChallenge[] = [];
  const sessions: Array<Record<string, unknown>> = [];
  const auditEvents: Array<Record<string, unknown>> = [];

  const queryRaw = async (strings: TemplateStringsArray): Promise<unknown[]> => {
    const sql = strings.join("");
    if (sql.includes("INSERT INTO identity_rate_limits")) {
      rateAttempts += 1;
      return [{ attempt_count: rateAttempts }];
    }
    if (sql.includes("FROM audit_chain_state")) {
      return [{ last_seq: auditSequence, last_hash: auditHash }];
    }
    return [];
  };

  const findChallenge = async ({ where }: { where: { id?: string; tokenHash?: Uint8Array } }) => {
    if (where.tokenHash) {
      return challenges.find((challenge) =>
        Buffer.from(challenge.tokenHash).equals(Buffer.from(where.tokenHash!)),
      ) ?? null;
    }
    return challenges.find((challenge) => challenge.id === where.id) ?? null;
  };

  const transaction = {
    $queryRaw: queryRaw,
    user: {
      findUnique: async () => user ? { ...user } : null,
      update: async ({ data }: { data: Partial<TestUser> }) => {
        if (!user) throw new Error("TEST_USER_MISSING");
        Object.assign(user, data);
        return { ...user };
      },
    },
    identityChallenge: {
      findUnique: findChallenge,
      updateMany: async ({ where, data }: {
        where: { userId: string; kind: string; consumedAt: null; revokedAt: null };
        data: { revokedAt: Date };
      }) => {
        let count = 0;
        for (const challenge of challenges) {
          if (challenge.userId === where.userId && challenge.kind === where.kind &&
              challenge.consumedAt === null && challenge.revokedAt === null) {
            challenge.revokedAt = data.revokedAt;
            count += 1;
          }
        }
        return { count };
      },
      create: async ({ data }: { data: Omit<TestChallenge, "id" | "consumedAt" | "revokedAt" | "failedAttempts"> }) => {
        const challenge: TestChallenge = {
          ...data,
          id: `challenge-${++challengeSequence}`,
          consumedAt: null,
          revokedAt: null,
          failedAttempts: 0,
        };
        challenges.push(challenge);
        return challenge;
      },
      update: async ({ where, data }: { where: { id: string }; data: Partial<TestChallenge> }) => {
        const challenge = challenges.find((item) => item.id === where.id);
        if (!challenge) throw new Error("TEST_CHALLENGE_MISSING");
        Object.assign(challenge, data);
        return challenge;
      },
    },
    session: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        sessions.push(data);
        return data;
      },
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        auditEvents.push(data);
        return data;
      },
    },
    auditChainState: {
      update: async ({ data }: { data: { lastSeq: bigint; lastHash: Uint8Array } }) => {
        auditSequence = data.lastSeq;
        auditHash = new Uint8Array(data.lastHash);
        return data;
      },
    },
  };

  const prisma = {
    $transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(transaction),
    user: {
      findUnique: async () => user ? { id: user.id } : null,
    },
    identityChallenge: { findUnique: findChallenge },
  } as unknown as PrismaClient;

  return { prisma, user, challenges, sessions, auditEvents };
}

async function activeTestUser(totpKey: Uint8Array, totpSecret: Uint8Array): Promise<TestUser> {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "ADMIN de prueba",
    email: "admin@example.invalid",
    role: "ADMIN",
    status: "ACTIVE",
    passwordHash: await hashPassword("Frase de prueba suficientemente larga 2026"),
    totpSecretCiphertext: encryptTotpSecret(totpSecret, totpKey),
    failedAttempts: 0,
    lockedUntil: null,
    lastTotpStep: null,
  };
}

describe("PrismaLoginService con persistencia simulada aislada", () => {
  it("bloquea tras cinco fallos, rechaza durante 15 minutos y recupera solo tras MFA válido", async () => {
    const totpKey = new Uint8Array(32).fill(13);
    const totpSecret = new Uint8Array(20).fill(29);
    const user = await activeTestUser(totpKey, totpSecret);
    const database = fakePrisma(user);
    const service = new PrismaLoginService(database.prisma, totpKey, new Uint8Array(32).fill(17));
    const now = new Date("2026-11-19T21:22:13.190-04:00");
    const wrongPassword = "Frase de prueba incorrecta 2026";

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(service.login(user.email, wrongPassword, "127.0.0.10", now))
        .resolves.toEqual({ ok: false, reason: "invalid" });
    }
    const lockedUntil = new Date(now.getTime() + 15 * 60_000);
    expect(user.failedAttempts).toBe(5);
    expect(user.lockedUntil).toEqual(lockedUntil);
    expect(database.auditEvents.at(-1)).toMatchObject({
      action: "AUTH_FAILURE",
      actorId: user.id,
      redactedDetails: { kind: "PASSWORD", attemptCount: 5, result: "LOCKED" },
    });

    await expect(service.login(user.email, "Frase de prueba suficientemente larga 2026",
      "127.0.0.10", new Date(lockedUntil.getTime() - 1)))
      .resolves.toEqual({ ok: false, reason: "invalid" });
    expect(user.failedAttempts).toBe(5);
    expect(user.lockedUntil).toEqual(lockedUntil);

    const challenge = await service.login(user.email, "Frase de prueba suficientemente larga 2026",
      "127.0.0.10", lockedUntil);
    expect(challenge).toMatchObject({ ok: true });
    if (!challenge.ok) throw new Error("TEST_LOGIN_CHALLENGE_NOT_CREATED");

    const code = totpCodeForTest(totpSecret, lockedUntil);
    const verified = await service.verify(challenge.challengeId, code, "127.0.0.10", lockedUntil);
    expect(verified).toMatchObject({ ok: true, user: { id: user.id, role: "ADMIN" } });
    expect(user.failedAttempts).toBe(0);
    expect(user.lockedUntil).toBeNull();
    expect(database.sessions).toHaveLength(1);
    expect(database.auditEvents.map((event) => event.action)).toContain("AUTH_MFA_SUCCESS");
    const serializedAudit = JSON.stringify(database.auditEvents, (_key, value: unknown) =>
      typeof value === "bigint" ? value.toString() : value);
    expect(serializedAudit).not.toContain(wrongPassword);
    expect(serializedAudit).not.toContain(code);
  });

  it("limita solicitudes TOTP después de veinte intentos en la ventana", async () => {
    const database = fakePrisma(null);
    const service = new PrismaLoginService(database.prisma, new Uint8Array(32).fill(13), new Uint8Array(32).fill(17));
    const now = new Date("2026-11-19T21:22:13.190-04:00");

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await expect(service.verify("A".repeat(43), "abcdef", "127.0.0.11", now))
        .resolves.toEqual({ ok: false, reason: "invalid" });
    }
    await expect(service.verify("A".repeat(43), "abcdef", "127.0.0.11", now))
      .resolves.toEqual({ ok: false, reason: "limited" });
    expect(database.auditEvents.at(-1)).toMatchObject({
      action: "AUTH_FAILURE",
      objectId: "UNKNOWN",
      redactedDetails: { kind: "TOTP", result: "LIMITED" },
    });
  });

  it("revoca el desafío tras tres TOTP incorrectos y no lo consume luego con un código válido", async () => {
    const totpKey = new Uint8Array(32).fill(13);
    const totpSecret = new Uint8Array(20).fill(29);
    const user = await activeTestUser(totpKey, totpSecret);
    const database = fakePrisma(user);
    const service = new PrismaLoginService(database.prisma, totpKey, new Uint8Array(32).fill(17));
    const now = new Date("2026-11-19T21:22:13.190-04:00");
    const password = "Frase de prueba suficientemente larga 2026";
    const challenge = await service.login(user.email, password, "127.0.0.12", now);
    expect(challenge).toMatchObject({ ok: true });
    if (!challenge.ok) throw new Error("TEST_LOGIN_CHALLENGE_NOT_CREATED");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(service.verify(challenge.challengeId, "abcdef", "127.0.0.12", now))
        .resolves.toEqual({ ok: false, reason: "invalid" });
    }

    expect(user.failedAttempts).toBe(3);
    expect(database.challenges[0]).toMatchObject({ failedAttempts: 3, revokedAt: now });
    await expect(service.verify(challenge.challengeId, totpCodeForTest(totpSecret, now), "127.0.0.12", now))
      .resolves.toEqual({ ok: false, reason: "invalid" });
    expect(database.sessions).toHaveLength(0);
  });
});
