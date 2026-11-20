import type { AnchorJobState, AnchorStatus } from "../../generated/prisma/enums.js";
import type { PrismaClient } from "../../generated/prisma/client.js";
import { appendAuditEvent } from "../audit/append-audit-event.js";
import type { AnchorConfirmation } from "./soroban-anchor-gateway.js";

export interface AnchorJobLease {
  readonly id: string;
  readonly alertId: string;
  readonly state: AnchorJobState;
  readonly leaseUntil: Date;
  readonly attemptCount: number;
}

export async function persistAnchorConfirmation(
  prisma: PrismaClient,
  claim: AnchorJobLease,
  evidence: AnchorConfirmation,
  expectedTxHash: string | null,
  now: Date,
): Promise<void> {
  if (evidence.source !== "transaction_and_readback" ||
      evidence.transactionStatus !== "SUCCESS" || evidence.contractReadMatched !== true ||
      evidence.confirmedLedger <= 0n || !Number.isFinite(evidence.verifiedAt.getTime()) ||
      evidence.verifiedAt.getTime() > now.getTime() ||
      (expectedTxHash !== null &&
        evidence.txHash.toLowerCase() !== expectedTxHash.toLowerCase())) {
    throw new Error("ANCHOR_CONFIRMATION_INVALID");
  }

  await prisma.$transaction(async (tx) => {
    const current = await tx.anchorJob.findUnique({
      where: { id: claim.id },
      select: { state: true, leaseUntil: true, txHash: true },
    });
    if (!current || current.state !== claim.state || current.leaseUntil === null ||
        current.leaseUntil.getTime() !== claim.leaseUntil.getTime() ||
        current.leaseUntil.getTime() <= now.getTime() ||
        (expectedTxHash !== null &&
          current.txHash?.toLowerCase() !== expectedTxHash.toLowerCase())) {
      throw new Error("ANCHOR_JOB_LEASE_LOST");
    }
    const updated = await tx.anchorJob.updateMany({
      where: {
        id: claim.id,
        state: current.state,
        leaseUntil: claim.leaseUntil,
        ...(expectedTxHash !== null ? { txHash: current.txHash } : {}),
      },
      data: {
        state: "CONFIRMED",
        txHash: evidence.txHash,
        confirmedLedger: evidence.confirmedLedger,
        leaseUntil: null,
        nextAttemptAt: null,
        lastErrorCode: null,
        sanitizedError: null,
      },
    });
    if (updated.count !== 1) throw new Error("ANCHOR_JOB_LEASE_LOST");
    const alertUpdated = await tx.alert.updateMany({
      where: {
        id: claim.alertId,
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: { in: ["PENDING", "SUBMITTED", "RETRYABLE_ERROR"] satisfies AnchorStatus[] },
      },
      data: {
        lifecycleState: "PUBLISHED",
        anchorStatus: "CONFIRMED",
        publishedAt: evidence.verifiedAt,
      },
    });
    if (alertUpdated.count !== 1) throw new Error("ANCHOR_ALERT_TRANSITION_FAILED");
    await appendAuditEvent(tx, {
      actorId: null,
      action: "ANCHOR_JOB_CONFIRMED",
      objectType: "anchor_job",
      objectId: claim.id,
      redactedDetails: {
        status: "SIGNED_PENDING_ANCHOR_TO_PUBLISHED",
        result: "SUCCESS_READBACK_MATCH",
        attemptCount: String(claim.attemptCount),
      },
      occurredAt: now,
    });
  }, { isolationLevel: "Serializable" });
}

export async function recordSubmittedReconciliationFailure(input: {
  readonly prisma: PrismaClient;
  readonly claim: AnchorJobLease;
  readonly code: string;
  readonly now: Date;
  readonly conflict: boolean;
}): Promise<void> {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(input.code)) {
    throw new Error("ANCHOR_FAILURE_CODE_INVALID");
  }
  await input.prisma.$transaction(async (tx) => {
    const current = await tx.anchorJob.findUnique({
      where: { id: input.claim.id },
      select: { state: true, leaseUntil: true },
    });
    if (!current || current.state !== input.claim.state || current.leaseUntil === null ||
        current.leaseUntil.getTime() !== input.claim.leaseUntil.getTime() ||
        current.leaseUntil.getTime() <= input.now.getTime()) {
      throw new Error("ANCHOR_JOB_LEASE_LOST");
    }
    const updated = await tx.anchorJob.updateMany({
      where: {
        id: input.claim.id,
        state: current.state,
        leaseUntil: input.claim.leaseUntil,
      },
      data: {
        ...(input.conflict ? {
          state: "CONFLICT" as const,
          leaseUntil: null,
          nextAttemptAt: null,
        } : {
          leaseUntil: null,
        }),
        lastErrorCode: input.code,
        sanitizedError: input.code,
      },
    });
    if (updated.count !== 1) throw new Error("ANCHOR_JOB_LEASE_LOST");
    if (input.conflict) {
      const alertUpdated = await tx.alert.updateMany({
        where: {
          id: input.claim.alertId,
          lifecycleState: "SIGNED_PENDING_ANCHOR",
          anchorStatus: "SUBMITTED",
        },
        data: { anchorStatus: "CONFLICT" },
      });
      if (alertUpdated.count !== 1) throw new Error("ANCHOR_ALERT_TRANSITION_FAILED");
    }
    await appendAuditEvent(tx, {
      actorId: null,
      action: input.conflict ? "ANCHOR_JOB_CONFLICT" : "ANCHOR_JOB_RESULT_UNCERTAIN",
      objectType: "anchor_job",
      objectId: input.claim.id,
      redactedDetails: {
        status: input.conflict ? "SUBMITTED_TO_CONFLICT" : "SUBMITTED_RECONCILIATION_REQUIRED",
        result: input.code,
        attemptCount: String(input.claim.attemptCount),
      },
      occurredAt: input.now,
    });
  }, { isolationLevel: "Serializable" });
}
