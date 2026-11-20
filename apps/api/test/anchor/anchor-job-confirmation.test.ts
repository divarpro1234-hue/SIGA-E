import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import {
  persistAnchorConfirmation,
  type AnchorJobLease,
} from "../../src/modules/anchor/anchor-job-confirmation.js";
import type { AnchorConfirmation } from "../../src/modules/anchor/soroban-anchor-gateway.js";

vi.mock("../../src/modules/audit/append-audit-event.js", () => ({
  appendAuditEvent: vi.fn(async () => 1n),
}));

const now = new Date("2026-11-07T12:00:00.000Z");
const txHash = "21c7bd0b60608f4cea0056ea54755e1258da27d3f141a0c42a3f26641b22865d";
const lease: AnchorJobLease = {
  id: "d7f5e3f6-4e58-4f20-b8ca-0e84fb792b8e",
  alertId: "1f84954a-ad6f-48d8-b280-fb531e6bf101",
  state: "SUBMITTED",
  leaseUntil: new Date("2026-11-07T12:02:00.000Z"),
  attemptCount: 2,
};
const evidence: AnchorConfirmation = {
  source: "transaction_and_readback",
  deploymentId: "trusted-deployment",
  contractId: "trusted-contract",
  messageKey: new Uint8Array(32).fill(1),
  jwsHash: new Uint8Array(32).fill(2),
  txHash,
  confirmedLedger: 5_565_212n,
  verifiedAt: now,
  transactionStatus: "SUCCESS",
  contractReadMatched: true,
};

function createPrisma(leaseUntil = lease.leaseUntil) {
  const tx = {
    anchorJob: {
      findUnique: vi.fn(async () => ({ state: "SUBMITTED", leaseUntil, txHash })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    alert: {
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (
      callback: (transaction: typeof tx) => Promise<void>,
      options: { readonly isolationLevel: string },
    ) => {
      expect(options.isolationLevel).toBe("Serializable");
      return callback(tx);
    }),
  } as unknown as PrismaClient;
  return { prisma, tx };
}

describe("persistencia de confirmación de anclaje", () => {
  it("actualiza job, alerta y auditoría en una sola transacción serializable", async () => {
    const { prisma, tx } = createPrisma();
    await persistAnchorConfirmation(prisma, lease, evidence, txHash, now);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.anchorJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: lease.id, state: "SUBMITTED", txHash }),
      data: expect.objectContaining({
        state: "CONFIRMED",
        txHash,
        confirmedLedger: 5_565_212n,
        leaseUntil: null,
        nextAttemptAt: null,
      }),
    }));
    expect(tx.alert.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: lease.alertId,
        lifecycleState: "SIGNED_PENDING_ANCHOR",
        anchorStatus: { in: ["PENDING", "SUBMITTED", "RETRYABLE_ERROR"] },
      }),
      data: expect.objectContaining({
        lifecycleState: "PUBLISHED",
        anchorStatus: "CONFIRMED",
        publishedAt: evidence.verifiedAt,
      }),
    }));
  });

  it("no publica si se perdió o expiró el lease", async () => {
    const { prisma, tx } = createPrisma(new Date(now.getTime() - 1));
    await expect(persistAnchorConfirmation(prisma, lease, evidence, txHash, now))
      .rejects.toThrow("ANCHOR_JOB_LEASE_LOST");
    expect(tx.anchorJob.updateMany).not.toHaveBeenCalled();
    expect(tx.alert.updateMany).not.toHaveBeenCalled();
  });
});
