import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { calculateAuditHash, withAuditedWrite } from "../../src/modules/audit/append-audit-event.js";
import type { AuditEventInput } from "../../src/modules/audit/append-audit-event.js";

const input: AuditEventInput = {
  actorId: null, action: "AUTH_FAILURE", objectType: "user", objectId: "system",
  redactedDetails: { reasonCode: "INVALID_CREDENTIALS", attemptCount: 1 },
  occurredAt: new Date("2026-10-12T00:00:00.000Z"),
};

class FakeAuditDatabase {
  seq = 0n;
  hash: Uint8Array = new Uint8Array(32);
  events: Array<{ seq: bigint; previousHash: Uint8Array; eventHash: Uint8Array }> = [];
  attempts = 0;
  failAuditInsert = false;
  private queue: Promise<void> = Promise.resolve();

  asPrisma(): PrismaClient {
    return { $transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const previous = this.queue;
      let unlock: () => void = () => undefined;
      this.queue = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      let nextSeq = this.seq;
      let nextHash: Uint8Array = this.hash;
      let nextAttempts = this.attempts;
      const created: typeof this.events = [];
      const tx = {
        $queryRaw: async () => [{ last_seq: nextSeq, last_hash: nextHash }],
        auditEvent: { create: async ({ data }: { data: typeof created[number] }) => {
          if (this.failAuditInsert) throw new Error("DB_WRITE_FAILURE");
          created.push(data);
        } },
        auditChainState: { update: async ({ data }: { data: { lastSeq: bigint; lastHash: Uint8Array } }) => {
          nextSeq = data.lastSeq;
          nextHash = data.lastHash;
        } },
        incrementAttempt: () => { nextAttempts += 1; },
      };
      try {
        const result = await callback(tx);
        this.seq = nextSeq;
        this.hash = nextHash;
        this.events.push(...created);
        this.attempts = nextAttempts;
        return result;
      } finally { unlock(); }
    } } as unknown as PrismaClient;
  }
}

describe("auditoría transaccional M1", () => {
  it("calcula exactamente SHA-256 de bytes previos más JSON canónico", () => {
    const canonical = '{"action":"AUTH_FAILURE","actorId":null,"objectId":"system","objectType":"user","occurredAt":"2026-10-12T00:00:00.000Z","redactedDetails":{"attemptCount":1,"reasonCode":"INVALID_CREDENTIALS"},"seq":"1"}';
    const expected = createHash("sha256").update(new Uint8Array(32)).update(canonical, "utf8").digest("hex");
    expect(Buffer.from(calculateAuditHash(new Uint8Array(32), 1n, input, input.occurredAt!)).toString("hex")).toBe(expected);
    expect(() => calculateAuditHash(new Uint8Array(32), 1n, {
      ...input, redactedDetails: { token: "valor" },
    }, input.occurredAt!)).toThrow("AUDIT_DETAILS_INVALID");
  });

  it("serializa escrituras concurrentes y enlaza cada cabeza", async () => {
    const db = new FakeAuditDatabase();
    const prisma = db.asPrisma();
    const results = await Promise.all(Array.from({ length: 12 }, (_, index) =>
      withAuditedWrite(prisma, async (tx) => {
        (tx as unknown as { incrementAttempt(): void }).incrementAttempt();
        return { value: { rejected: true, index }, audit: input };
      })));
    expect(results).toHaveLength(12);
    expect(db.attempts).toBe(12);
    expect(db.seq).toBe(12n);
    expect(db.events.map((event) => event.seq)).toEqual(Array.from({ length: 12 }, (_, index) => BigInt(index + 1)));
    for (let index = 1; index < db.events.length; index += 1) {
      expect(db.events[index]?.previousHash).toEqual(db.events[index - 1]?.eventHash);
    }
    expect(db.hash).toEqual(db.events.at(-1)?.eventHash);
  });

  it("revierte contador y cabeza si la auditoría falla; confirma el rechazo esperado", async () => {
    const db = new FakeAuditDatabase();
    db.failAuditInsert = true;
    await expect(withAuditedWrite(db.asPrisma(), async (tx) => {
      (tx as unknown as { incrementAttempt(): void }).incrementAttempt();
      return { value: { rejected: true }, audit: input };
    })).rejects.toThrow("DB_WRITE_FAILURE");
    expect(db.attempts).toBe(0);
    expect(db.seq).toBe(0n);
    expect(db.events).toHaveLength(0);
    db.failAuditInsert = false;
    const result = await withAuditedWrite(db.asPrisma(), async (tx) => {
      (tx as unknown as { incrementAttempt(): void }).incrementAttempt();
      return { value: { rejected: true }, audit: input };
    });
    expect(result).toEqual({ rejected: true });
    expect(db.attempts).toBe(1);
    expect(db.seq).toBe(1n);
  });
});
