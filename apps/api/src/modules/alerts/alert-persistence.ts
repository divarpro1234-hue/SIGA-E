import { z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { validateAlertInput, validateMessageIdentity } from "./alert-input.js";
import { payloadDigestMatches } from "./alert-payload.js";
import type { PayloadSnapshot } from "./alert-payload.js";

export const MAX_ALERT_VERSION = 2_147_483_647;
export type PersistenceErrorCode = "INVALID_PERSISTENCE_INPUT" | "PAYLOAD_INTEGRITY_ERROR" |
  "STALE_ALERT_VERSION" | "INVALID_STATE_TRANSITION" | "ALERT_ID_DUPLICATE" |
  "VERSION_LIMIT_REACHED" | "PERSISTENCE_CONFLICT" | "PERSISTENCE_FAILURE";

export class AlertPersistenceError extends Error {
  override readonly name = "AlertPersistenceError";
  constructor(readonly code: PersistenceErrorCode) { super(code); }
}

export function requireVersion(version: number, increment = false): void {
  if (!Number.isInteger(version) || version < 1 || version > MAX_ALERT_VERSION) {
    throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
  }
  if (increment && version === MAX_ALERT_VERSION) throw new AlertPersistenceError("VERSION_LIMIT_REACHED");
}

export function requireUuid(value: string): void {
  if (!z.uuid().safeParse(value).success) throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
}

const envelope = z.strictObject({
  sender: z.string(), identifier: z.string(), sent: z.string(),
  status: z.literal("Exercise"), scope: z.literal("Public"), msgType: z.literal("Alert"),
  info: z.unknown(),
});

/** Inspect a copy for consistency only. Never stringify or replace persisted bytes. */
export function inspectPayload(bytes: Uint8Array, digest: Uint8Array) {
  try {
    if (!payloadDigestMatches(bytes, digest)) throw new Error();
    const parsed = envelope.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    validateMessageIdentity(parsed);
    const input = validateAlertInput({ kind: "Alert", info: parsed.info }, parsed.sent);
    return { sender: parsed.sender, identifier: parsed.identifier, sentText: parsed.sent,
      kind: input.kind, severity: input.info.severity };
  } catch {
    throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
  }
}

export function frozenData(payload: PayloadSnapshot<"FROZEN">) {
  if (payload.phase !== "FROZEN") throw new AlertPersistenceError("INVALID_STATE_TRANSITION");
  const frozenPayload = Uint8Array.from(payload.payloadBytes);
  const payloadSha256 = Uint8Array.from(payload.payloadDigest);
  const metadata = inspectPayload(frozenPayload, payloadSha256);
  if (Buffer.from(payloadSha256).toString("hex") !== payload.payloadDigestHex) {
    throw new AlertPersistenceError("PAYLOAD_INTEGRITY_ERROR");
  }
  return { ...metadata, frozenPayload, payloadSha256 };
}

export interface ReviewedDecisionInput {
  readonly alertId: string;
  readonly approverId: string;
  readonly alertVersion: number;
  readonly reviewedPayload: Uint8Array;
  readonly digest: Uint8Array;
  readonly reviewedAt: Date;
}
export type DecisionInput = ReviewedDecisionInput & (
  { readonly decision: "APPROVED"; readonly reason: null } |
  { readonly decision: "REJECTED"; readonly reason: string }
);

/** Data preparation only. Service must verify actor, pending version, digest and atomic audit before insertion. */
export function prepareApprovalData(input: DecisionInput): Prisma.ApprovalUncheckedCreateInput {
  requireUuid(input.alertId);
  requireUuid(input.approverId);
  requireVersion(input.alertVersion, true);
  const reviewedPayload = Uint8Array.from(input.reviewedPayload);
  const digest = Uint8Array.from(input.digest);
  inspectPayload(reviewedPayload, digest);
  const validReason = input.decision === "APPROVED" ? input.reason === null :
    input.decision === "REJECTED" && typeof input.reason === "string" &&
    Array.from(input.reason).length >= 3 && Array.from(input.reason).length <= 500 &&
    !input.reason.includes("\u0000");
  if (!validReason || !(input.reviewedAt instanceof Date) || !Number.isFinite(input.reviewedAt.getTime())) {
    throw new AlertPersistenceError("INVALID_PERSISTENCE_INPUT");
  }
  return {
    alertId: input.alertId, approverId: input.approverId, alertVersion: input.alertVersion,
    reviewedPayload, digest, decision: input.decision, reason: input.reason,
    reviewedAt: new Date(input.reviewedAt),
  };
}

export async function persistenceCall<T>(operation: () => Promise<T>, creatingAlert = false): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof AlertPersistenceError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    if (code === "P2002" && creatingAlert) throw new AlertPersistenceError("ALERT_ID_DUPLICATE");
    if (code === "P2002" || code === "P2025" || code === "P2034") {
      throw new AlertPersistenceError("PERSISTENCE_CONFLICT");
    }
    // Do not attach driver messages, metadata or cause (potential SQL/content/credentials).
    throw new AlertPersistenceError("PERSISTENCE_FAILURE");
  }
}
