import { createHash } from "node:crypto";

import { Prisma, type PrismaClient } from "../../generated/prisma/client.js";

const detailKeys = new Set(["reasonCode", "role", "status", "kind", "result", "requestId", "attemptCount", "automaticFailureCount"]);
const safeAtom = /^[A-Za-z0-9_-]{1,64}$/u;

type SafeDetail = string | number | boolean | null;

export interface AuditEventInput {
  readonly actorId: string | null;
  readonly action: string;
  readonly objectType: string;
  readonly objectId: string;
  readonly redactedDetails: Readonly<Record<string, SafeDetail>>;
  readonly occurredAt?: Date;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    const parts = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${parts.join(",")}}`;
  }
  throw new TypeError("AUDIT_CANONICAL_JSON_INVALID");
}

function validateInput(input: AuditEventInput): void {
  for (const value of [input.action, input.objectType, input.objectId]) {
    if (!safeAtom.test(value)) throw new TypeError("AUDIT_FIELD_INVALID");
  }
  if (input.actorId !== null && !/^[0-9a-fA-F-]{36}$/u.test(input.actorId)) throw new TypeError("AUDIT_ACTOR_INVALID");
  const details = input.redactedDetails;
  if (!details || typeof details !== "object" || Array.isArray(details) || Object.getPrototypeOf(details) !== Object.prototype) {
    throw new TypeError("AUDIT_DETAILS_INVALID");
  }
  if (Object.keys(details).length > 7) throw new TypeError("AUDIT_DETAILS_INVALID");
  for (const [key, value] of Object.entries(details)) {
    if (!detailKeys.has(key) ||
        !(value === null || typeof value === "boolean" ||
          (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000) ||
          (typeof value === "string" && safeAtom.test(value)))) {
      throw new TypeError("AUDIT_DETAILS_INVALID");
    }
  }
  if (input.occurredAt && !Number.isFinite(input.occurredAt.getTime())) throw new TypeError("AUDIT_TIME_INVALID");
}

export function calculateAuditHash(previousHash: Uint8Array, seq: bigint, input: AuditEventInput, occurredAt: Date): Uint8Array<ArrayBuffer> {
  validateInput(input);
  if (previousHash.length !== 32 || seq <= 0n || !Number.isFinite(occurredAt.getTime())) throw new TypeError("AUDIT_CHAIN_INVALID");
  const canonical = canonicalJson({
    seq: seq.toString(10), occurredAt: occurredAt.toISOString(), actorId: input.actorId,
    action: input.action, objectType: input.objectType, objectId: input.objectId,
    redactedDetails: input.redactedDetails,
  });
  return new Uint8Array(createHash("sha256").update(previousHash).update(canonical, "utf8").digest());
}

/** Debe invocarse dentro de la misma transacción que la mutación crítica. */
export async function appendAuditEvent(tx: Prisma.TransactionClient, input: AuditEventInput): Promise<bigint> {
  validateInput(input);
  const rows = await tx.$queryRaw<Array<{ last_seq: bigint; last_hash: Uint8Array }>>`
    SELECT last_seq, last_hash FROM audit_chain_state WHERE id = 1 FOR UPDATE
  `;
  if (rows.length !== 1 || rows[0]?.last_hash.length !== 32 || rows[0].last_seq < 0n) {
    throw new Error("AUDIT_CHAIN_UNAVAILABLE");
  }
  const head = rows[0];
  const seq = head.last_seq + 1n;
  const occurredAt = input.occurredAt ?? new Date();
  const previousHash = new Uint8Array(head.last_hash);
  const eventHash = calculateAuditHash(previousHash, seq, input, occurredAt);
  await tx.auditEvent.create({ data: {
    seq, occurredAt, actorId: input.actorId, action: input.action,
    objectType: input.objectType, objectId: input.objectId,
    redactedDetails: { ...input.redactedDetails }, previousHash, eventHash,
  } });
  await tx.auditChainState.update({ where: { id: 1 }, data: { lastSeq: seq, lastHash: eventHash } });
  return seq;
}

/** El rechazo esperado se devuelve como valor; así se confirman contador y evento antes del HTTP 401/429. */
export async function withAuditedWrite<T>(
  prisma: PrismaClient,
  mutation: (tx: Prisma.TransactionClient) => Promise<{ value: T; audit: AuditEventInput }>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    const result = await mutation(tx);
    await appendAuditEvent(tx, result.audit);
    return result.value;
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
