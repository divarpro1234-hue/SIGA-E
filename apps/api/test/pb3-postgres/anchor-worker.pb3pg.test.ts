import { randomUUID } from "node:crypto";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/client.js";
import { buildDraftPayload } from "../../src/modules/alerts/alert-payload.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import {
  PrismaAnchorWorker,
  type AnchorWorkerResult,
} from "../../src/modules/anchor/anchor-worker.js";
import type {
  AnchorConfirmation,
  AnchorReconciliation,
  AnchorRequest,
  AnchorSubmission,
  SorobanAnchorGateway,
} from "../../src/modules/anchor/soroban-anchor-gateway.js";
import { JoseAlertSigner } from "../../src/modules/signing/jose-alert-signer.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";
import {
  assertAuditSegment,
  assertM5LabIsEmptyForWorker,
  assertM5QueueIsIdle,
  assertNextM5JobIs,
  createSyntheticDeployment,
  guardedRead,
  guardedWorkerClient,
  openM5AnchorLab,
  seedM5AnchorJob,
  type M5FailureEvidence,
  type M5SyntheticAlert,
  type TransactionEntryBarrier,
} from "./harness.js";
import type { AnchorDeploymentTrustPolicy } from "../../src/modules/anchor/anchor-worker.js";

const LAB_MARKER = "SIMULACRO_M5_POSTGRES_EVIDENCE";
const TX_HASH = "a1".repeat(32);
const policy = {
  leaseDurationMs: 60_000,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 10_000,
  maxAutomaticFailures: 3,
  pollDelayMs: 1_000,
};

type SyntheticFixture = {
  readonly alert: M5SyntheticAlert;
  readonly gateway: LaboratoryGateway;
};

class LaboratoryGateway implements SorobanAnchorGateway {
  readonly trustDomain = "OFFLINE_LAB" as const;
  readonly reconcileCalls: AnchorRequest[] = [];
  readonly submitCalls: AnchorRequest[] = [];
  syntheticEvidenceMarker: string | null = null;
  onReconcile: ((request: AnchorRequest) => Promise<AnchorReconciliation>) | undefined;
  onSubmit: ((request: AnchorRequest) => Promise<AnchorSubmission>) | undefined;

  async reconcile(request: AnchorRequest): Promise<AnchorReconciliation> {
    this.reconcileCalls.push(request);
    if (this.onReconcile) return this.onReconcile(request);
    return {
      kind: "absent",
      deploymentId: request.deployment.id,
      contractId: request.deployment.contractId,
      messageKey: request.messageKey,
      observedContractHash: null,
      priorTransactionStatus: "NOT_APPLICABLE",
    };
  }

  async submit(request: AnchorRequest): Promise<AnchorSubmission> {
    this.submitCalls.push(request);
    if (this.onSubmit) return this.onSubmit(request);
    return {
      kind: "submitted",
      receipt: {
        deploymentId: request.deployment.id,
        contractId: request.deployment.contractId,
        messageKey: request.messageKey,
        txHash: TX_HASH,
        transactionStatus: "PENDING",
      },
    };
  }

  confirmation(request: AnchorRequest): AnchorConfirmation {
    const evidence = {
      source: "transaction_and_readback",
      deploymentId: request.deployment.id,
      contractId: request.deployment.contractId,
      messageKey: request.messageKey,
      jwsHash: request.jwsHash,
      txHash: TX_HASH,
      confirmedLedger: 1n,
      verifiedAt: new Date(),
      transactionStatus: "SUCCESS",
      contractReadMatched: true,
      laboratoryMarker: LAB_MARKER,
    } satisfies AnchorConfirmation & { readonly laboratoryMarker: string };
    this.syntheticEvidenceMarker = evidence.laboratoryMarker;
    return evidence;
  }
}

describe.skipIf(process.env["SIGAE_RUN_PB3_POSTGRES_ANCHOR"] !== "I_ACKNOWLEDGE_PB3_ANCHOR_WRITES")("PB3 PostgreSQL: presupuesto persistente con gateway OFFLINE_LAB", () => {
  let lab!: Awaited<ReturnType<typeof openM5AnchorLab>> & {
    readonly deploymentId: string;
    readonly deploymentTrustPolicy: AnchorDeploymentTrustPolicy;
  };

  beforeAll(async () => {
    const opened = await openM5AnchorLab();
    await assertM5LabIsEmptyForWorker(opened.writer);
    const deployment = await createSyntheticDeployment(opened.writer);
    lab = {
      ...opened,
      deploymentId: deployment.id,
      deploymentTrustPolicy: deployment.trustPolicy,
    };
  });

  afterAll(async () => {
    await Promise.all([
      lab?.writer.$disconnect(),
      lab?.observer.$disconnect(),
      lab?.contender.$disconnect(),
      lab?.lockClient.end(),
    ]);
  });

  async function createFixture(tamper: "none" | "jws" | "hash" = "none"): Promise<SyntheticFixture> {
    const runId = randomUUID();
    const sender = "urn:siga-e:simulacro";
    const sent = new Date(Date.now() - 1_000).toISOString();
    const identifier = `urn:uuid:${runId}`;
    const input = validateAlertInput({
      kind: "Alert",
      info: {
        scenario: "SISMO",
        event: "Evento académico ficticio SIMULACRO",
        severity: "Severe",
        urgency: "Immediate",
        certainty: "Likely",
        headline: `SIMULACRO M5 ${runId}`,
        description: `Prueba sintética del AnchorWorker ${runId}`,
        expires: new Date(Date.now() + 60 * 60_000).toISOString(),
        areaDesc: "Zona ficticia de laboratorio",
      },
    }, sent);
    const identity = { sender, identifier, sent };
    const snapshot = buildDraftPayload(input, identity);
    const pair = await generateKeyPair("ES256");
    const kid = `m5-postgres-${runId}`;
    const signer = new JoseAlertSigner(pair.privateKey, kid);
    const compact = await signer.sign(snapshot.payloadBytes);
    const [protectedHeader, payloadSegment, signatureSegment] = compact.split(".");
    if (protectedHeader === undefined || payloadSegment === undefined || signatureSegment === undefined) {
      throw new Error("M5_ANCHOR_TEST_JWS_FORMAT_INVALID");
    }
    const storedJws = tamper === "jws"
      ? `${protectedHeader}.${payloadSegment}.${signatureSegment.startsWith("A") ? "B" : `A${signatureSegment.slice(1)}`}`
      : compact;
    const exported = await exportJWK(pair.publicKey);
    const publicJwk: JWK = { ...exported, kid };
    const thumbprint = await calculateJwkThumbprint(exported, "sha256");
    const digest = calculateJwsHash(storedJws);
    if (tamper === "hash") digest[0] = digest[0]! ^ 0xff;
    const messageKey = calculateMessageKey(identity);
    const alert = await seedM5AnchorJob(lab.writer, lab.deploymentId, {
      jwsCompact: storedJws,
      kid,
      publicJwk: publicJwk as Prisma.InputJsonValue,
      thumbprint,
      frozenPayload: snapshot.payloadBytes,
      payloadDigest: snapshot.payloadDigest,
      messageKey,
      jwsHash: digest,
      sent,
      identifier,
      sender,
    });
    return { alert, gateway: new LaboratoryGateway() };
  }

  let pb3Now = new Date();

  function worker(
    gateway: SorobanAnchorGateway,
    prisma: PrismaClient = lab.writer,
    options: {
      readonly failurePoint?: "after_anchor_job_confirmation";
      readonly failureEvidence?: M5FailureEvidence;
      readonly selectionBarrier?: TransactionEntryBarrier;
    } = {},
  ) {
    return new PrismaAnchorWorker(guardedWorkerClient(prisma, options), gateway, policy, {
      deploymentTrustPolicy: lab.deploymentTrustPolicy,
      allowOfflineGateway: true,
      clock: { now: () => new Date(pb3Now.getTime()) },
    });
  }

  async function inspect(alertId: string, jobId: string) {
    return guardedRead(lab.observer, async (tx) => {
      const alert = await tx.alert.findUniqueOrThrow({ where: { id: alertId } });
      const job = await tx.anchorJob.findUniqueOrThrow({ where: { id: jobId } });
      const head = await tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } });
      return { alert, job, head };
    });
  }

  async function readHead() {
    return guardedRead(lab.observer, (tx) =>
      tx.auditChainState.findUniqueOrThrow({ where: { id: 1 } }));
  }

  async function runOne(
    fixture: SyntheticFixture,
    options: Parameters<typeof worker>[2] = {},
  ): Promise<{ readonly result: AnchorWorkerResult; readonly before: { seq: bigint; hash: Uint8Array } }> {
    await assertNextM5JobIs(lab.observer, fixture.alert.jobId);
    const before = await readHead();
    const service = await worker(fixture.gateway, lab.writer, options);
    const result = await service.processNext();
    return {
      result,
      before: { seq: before.lastSeq, hash: Uint8Array.from(before.lastHash) },
    };
  }


  it("PB3-PG1: tres fallos recuperables persisten FAILED sin publicar", async () => {
    const fixture = await createFixture();
    const start = new Date();

    pb3Now = start;

    fixture.gateway.onReconcile = async (request) => ({
      kind: "absent",
      deploymentId: request.deployment.id,
      contractId: request.deployment.contractId,
      messageKey: Uint8Array.from(request.messageKey),
      observedContractHash: null,
      priorTransactionStatus: request.attemptCount === 1
        ? "NOT_APPLICABLE"
        : "NOT_FOUND_AFTER_RECONCILIATION",
    });

    fixture.gateway.onSubmit = async () => ({
      kind: "retryable_failure",
      code: "RPC_REJECTED",
    });

    const first = await runOne(fixture);

    expect(first.result.kind).toBe("retryable");

    for (let i = 1; i < 3; i++) {
      pb3Now = new Date(start.getTime() + i * 90_000);

      const service = worker(fixture.gateway);
      const result = await service.processNext();

      expect(result.kind).toBe(
        i === 2 ? "failed" : "retryable",
      );

      const snapshot = await inspect(
        fixture.alert.alertId,
        fixture.alert.jobId,
      );

      expect(snapshot.job.automaticFailureCount).toBe(i + 1);
    }

    const after = await inspect(
      fixture.alert.alertId,
      fixture.alert.jobId,
    );

    expect(after.job.state).toBe("FAILED");
    expect(after.job.automaticFailureCount).toBe(3);
    expect(after.job.attemptCount).toBe(3);
    expect(after.job.nextAttemptAt).toBeNull();
    expect(after.job.lastErrorCode).toBe("RETRY_LIMIT_EXHAUSTED");

    expect(after.alert.anchorStatus).toBe("FAILED");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();

    pb3Now = new Date(start.getTime() + 4 * 90_000);

    await expect(worker(fixture.gateway).processNext())
      .resolves.toMatchObject({ kind: "idle" });

    expect(fixture.gateway.submitCalls).toHaveLength(3);

    await assertAuditSegment(lab.observer, first.before, [
      "ANCHOR_JOB_CLAIMED",
      "ANCHOR_JOB_RETRYABLE",
      "ANCHOR_JOB_CLAIMED",
      "ANCHOR_JOB_RETRYABLE",
      "ANCHOR_JOB_CLAIMED",
      "ANCHOR_JOB_RETRY_EXHAUSTED",
    ]);

    await assertM5QueueIsIdle(lab.observer);
  });

  it("PB3-PG2: incertidumbre persistente termina en REVIEW_REQUIRED", async () => {
    const fixture = await createFixture();
    const start = new Date();

    pb3Now = start;

    fixture.gateway.onReconcile = async () => ({
      kind: "unknown",
      code: "RPC_UNAVAILABLE",
    });

    const first = await runOne(fixture);

    expect(first.result.kind).toBe("uncertain");

    for (let i = 1; i < 3; i++) {
      pb3Now = new Date(start.getTime() + i * 90_000);

      const result = await worker(fixture.gateway).processNext();

      expect(result.kind).toBe(
        i === 2 ? "review_required" : "uncertain",
      );
    }

    const after = await inspect(
      fixture.alert.alertId,
      fixture.alert.jobId,
    );

    expect(after.job.state).toBe("REVIEW_REQUIRED");
    expect(after.job.automaticFailureCount).toBe(3);
    expect(after.job.attemptCount).toBe(3);
    expect(after.job.nextAttemptAt).toBeNull();
    expect(after.job.leaseUntil).toBeNull();

    expect(after.alert.anchorStatus).toBe("REVIEW_REQUIRED");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();

    pb3Now = new Date(start.getTime() + 4 * 90_000);

    await expect(worker(fixture.gateway).processNext())
      .resolves.toMatchObject({ kind: "idle" });

    expect(fixture.gateway.submitCalls).toHaveLength(0);

    await assertAuditSegment(lab.observer, first.before, [
      "ANCHOR_JOB_CLAIMED",
      "ANCHOR_JOB_RESULT_UNCERTAIN",
      "ANCHOR_JOB_CLAIMED",
      "ANCHOR_JOB_RESULT_UNCERTAIN",
      "ANCHOR_JOB_CLAIMED",
      "ANCHOR_JOB_REVIEW_REQUIRED",
    ]);

    await assertM5QueueIsIdle(lab.observer);
  });

  it("PB3-PG3: SUBMITTED pendiente no consume fallos ni reenvia", async () => {
    const fixture = await createFixture();
    const start = new Date();

    pb3Now = start;

    fixture.gateway.onReconcile = async (request) => {
      if (request.attemptCount === 1) {
        return {
          kind: "absent",
          deploymentId: request.deployment.id,
          contractId: request.deployment.contractId,
          messageKey: Uint8Array.from(request.messageKey),
          observedContractHash: null,
          priorTransactionStatus: "NOT_APPLICABLE",
        };
      }

      return {
        kind: "submitted",
        receipt: {
          deploymentId: request.deployment.id,
          contractId: request.deployment.contractId,
          messageKey: Uint8Array.from(request.messageKey),
          txHash: TX_HASH,
          transactionStatus: "PENDING",
        },
      };
    };

    const first = await runOne(fixture);

    expect(first.result.kind).toBe("submitted");
    expect(fixture.gateway.submitCalls).toHaveLength(1);

    for (let i = 1; i <= 5; i++) {
      pb3Now = new Date(start.getTime() + i * 90_000);

      const result = await worker(fixture.gateway).processNext();

      expect(result.kind).toBe("submitted");

      const snapshot = await inspect(
        fixture.alert.alertId,
        fixture.alert.jobId,
      );

      expect(snapshot.job.automaticFailureCount).toBe(0);
    }

    const after = await inspect(
      fixture.alert.alertId,
      fixture.alert.jobId,
    );

    expect(after.job.state).toBe("SUBMITTED");
    expect(after.job.automaticFailureCount).toBe(0);
    expect(after.job.attemptCount).toBe(6);

    expect(after.alert.anchorStatus).toBe("SUBMITTED");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();

    // Un envio simulado inicial; las cinco consultas no reenvian.
    expect(fixture.gateway.submitCalls).toHaveLength(1);
    expect(fixture.gateway.reconcileCalls).toHaveLength(6);
  });
});