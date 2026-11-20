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
  transactionEntryBarrier,
  type M5FailureEvidence,
  type M5SyntheticAlert,
  type TransactionEntryBarrier,
} from "./harness.js";
import type { AnchorDeploymentTrustPolicy } from "../../src/modules/anchor/anchor-worker.js";

const LAB_MARKER = "SIMULACRO_M5_POSTGRES_EVIDENCE";
const TX_HASH = "a1".repeat(32);
const policy = {
  leaseDurationMs: 10 * 60_000,
  retryBaseDelayMs: 60 * 60_000,
  retryMaxDelayMs: 24 * 60 * 60_000,
  maxAutomaticFailures: 3,
  pollDelayMs: 60 * 60_000,
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

describe("M5 PostgreSQL real: AnchorWorker (SIMULACRO; gateway sin RPC)", () => {
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

  it("A: selecciona el job real; CAS, lease, contador y auditoría se persisten", async () => {
    const fixture = await createFixture();
    let leaseObserved: { state: string; attemptCount: number; leaseUntil: Date | null } | undefined;
    fixture.gateway.onReconcile = async (request) => {
      leaseObserved = await guardedRead(lab.observer, async (tx) => {
        const job = await tx.anchorJob.findUniqueOrThrow({ where: { id: fixture.alert.jobId } });
        return { state: job.state, attemptCount: job.attemptCount, leaseUntil: job.leaseUntil };
      });
      expect(request.attemptCount).toBe(1);
      return {
        kind: "absent",
        deploymentId: request.deployment.id,
        contractId: request.deployment.contractId,
        messageKey: request.messageKey,
        observedContractHash: null,
        priorTransactionStatus: "NOT_APPLICABLE",
      };
    };
    const { result, before } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(result.kind).toBe("submitted");
    expect(leaseObserved).toMatchObject({ state: "LEASED", attemptCount: 1 });
    expect(leaseObserved?.leaseUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(after.job.state).toBe("SUBMITTED");
    expect(after.job.attemptCount).toBe(1);
    expect(after.job.leaseUntil).toBeNull();
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.anchorStatus).toBe("SUBMITTED");
    expect(after.alert.publishedAt).toBeNull();
    expect(fixture.gateway.reconcileCalls).toHaveLength(1);
    expect(fixture.gateway.submitCalls).toHaveLength(1);
    await assertAuditSegment(lab.observer, before, ["ANCHOR_JOB_CLAIMED", "ANCHOR_JOB_SUBMITTED"]);

    await assertM5QueueIsIdle(lab.observer);
    const duplicate = await worker(fixture.gateway).processNext();
    expect(duplicate.kind).toBe("idle");
    expect(fixture.gateway.submitCalls).toHaveLength(1);
  });

  it("B: dos transacciones leen el mismo candidato antes del CAS; solo una lo reclama", async () => {
    const fixture = await createFixture();
    await assertNextM5JobIs(lab.observer, fixture.alert.jobId);
    const barrier = transactionEntryBarrier(2);
    const gateway = fixture.gateway;
    const first = await worker(gateway, lab.writer, { selectionBarrier: barrier.barrier });
    const second = await worker(gateway, lab.contender, { selectionBarrier: barrier.barrier });
    const outcomes = await Promise.allSettled([first.processNext(), second.processNext()]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const claimed = fulfilled.filter((outcome) => outcome.status === "fulfilled" && outcome.value.kind !== "idle");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(barrier.arrivals()).toBe(2);
    expect(claimed).toHaveLength(1);
    expect(rejected.length).toBeLessThanOrEqual(1);
    if (rejected.length === 1) {
      const reason: unknown = rejected[0]?.status === "rejected" ? rejected[0].reason : undefined;
      expect(reason).toMatchObject({ code: "P2034" });
    } else {
      expect(fulfilled).toHaveLength(2);
      expect(fulfilled.some((outcome) =>
        outcome.status === "fulfilled" && outcome.value.kind === "idle")).toBe(true);
    }
    expect(after.job.attemptCount).toBe(1);
    expect(gateway.reconcileCalls).toHaveLength(1);
    expect(gateway.submitCalls).toHaveLength(1);
  });

  it("C: JWS manipulado se marca no verificable sin llamar al gateway ni publicar", async () => {
    const fixture = await createFixture("jws");
    const { result } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(result).toMatchObject({ kind: "unverifiable", reason: "JOB_INTEGRITY_FAILED" });
    expect(fixture.gateway.reconcileCalls).toHaveLength(0);
    expect(fixture.gateway.submitCalls).toHaveLength(0);
    expect(after.job.state).toBe("UNVERIFIABLE");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.anchorStatus).toBe("UNVERIFIABLE");
    expect(after.alert.publishedAt).toBeNull();
  });

  it("C2: un digest persistido incompatible no se envía ni se publica", async () => {
    const fixture = await createFixture("hash");
    const { result } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(result).toMatchObject({ kind: "unverifiable", reason: "JOB_INTEGRITY_FAILED" });
    expect(fixture.gateway.reconcileCalls).toHaveLength(0);
    expect(fixture.gateway.submitCalls).toHaveLength(0);
    expect(after.job.state).toBe("UNVERIFIABLE");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();
  });

  it("D: resultado externo incierto mantiene lease y trazabilidad para reconciliar", async () => {
    const fixture = await createFixture();
    fixture.gateway.onReconcile = async () => ({ kind: "unknown", code: "RESULT_UNCERTAIN" });
    const { result } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(result.kind).toBe("uncertain");
    expect(after.job.state).toBe("LEASED");
    expect(after.job.attemptCount).toBe(1);
    expect(after.job.leaseUntil?.getTime()).toBeGreaterThan(Date.now());
    expect(after.job.lastErrorCode).toBe("RESULT_UNCERTAIN");
    expect(after.job.txHash).toBeNull();
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();
    expect(fixture.gateway.submitCalls).toHaveLength(0);
  });

  it("E: fallo recuperable persiste el backoff sin duplicar ni publicar", async () => {
    const fixture = await createFixture();
    fixture.gateway.onSubmit = async () => ({
      kind: "retryable_failure",
      code: "RPC_REJECTED",
    });
    const { result } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(result.kind).toBe("retryable");
    expect(after.job.state).toBe("RETRYABLE");
    expect(after.job.attemptCount).toBe(1);
    expect(after.job.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + policy.retryBaseDelayMs - 5_000);
    expect(after.job.leaseUntil).toBeNull();
    expect(after.alert.anchorStatus).toBe("RETRYABLE_ERROR");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();
    await assertM5QueueIsIdle(lab.observer);
    await expect(worker(fixture.gateway).processNext()).resolves.toMatchObject({ kind: "idle" });
  });

  it("F: evidencia de confirmación simulada publica solo dentro de la transacción de persistencia", async () => {
    const fixture = await createFixture();
    fixture.gateway.onReconcile = async (request) => ({
      kind: "confirmed",
      evidence: fixture.gateway.confirmation(request),
    });
    const { result, before } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(fixture.gateway.syntheticEvidenceMarker).toBe(LAB_MARKER);
    expect(result.kind).toBe("confirmed");
    expect(after.job.state).toBe("CONFIRMED");
    expect(after.alert.lifecycleState).toBe("PUBLISHED");
    expect(after.alert.anchorStatus).toBe("CONFIRMED");
    expect(after.alert.publishedAt).toBeInstanceOf(Date);
    await assertAuditSegment(lab.observer, before, ["ANCHOR_JOB_CLAIMED", "ANCHOR_JOB_CONFIRMED"]);
  });

  it("G: el observador independiente verifica rollback tras escritura crítica", async () => {
    const fixture = await createFixture();
    fixture.gateway.onReconcile = async (request) => ({
      kind: "confirmed",
      evidence: fixture.gateway.confirmation(request),
    });
    await assertNextM5JobIs(lab.observer, fixture.alert.jobId);
    const before = await readHead();
    const evidence: M5FailureEvidence = {
      afterAnchorJobConfirmation: { value: false },
    };
    const failingWorker = await worker(fixture.gateway, lab.writer, {
      failurePoint: "after_anchor_job_confirmation",
      failureEvidence: evidence,
    });

    await expect(failingWorker.processNext()).rejects.toThrow("M5_ANCHOR_INJECTED_ROLLBACK");
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(evidence.afterAnchorJobConfirmation.value).toBe(true);
    expect(after.job.state).toBe("LEASED");
    expect(after.job.leaseUntil).not.toBeNull();
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.anchorStatus).toBe("PENDING");
    expect(after.alert.publishedAt).toBeNull();
    await assertAuditSegment(
      lab.observer,
      { seq: before.lastSeq, hash: Uint8Array.from(before.lastHash) },
      ["ANCHOR_JOB_CLAIMED"],
    );
  });

  it("H: gateway no disponible se registra como incierto, nunca como fallo definitivo", async () => {
    const fixture = await createFixture();
    fixture.gateway.onReconcile = async () => {
      throw new Error("simulated transport failure");
    };
    const { result } = await runOne(fixture);
    const after = await inspect(fixture.alert.alertId, fixture.alert.jobId);

    expect(result.kind).toBe("uncertain");
    expect(after.job.state).toBe("LEASED");
    expect(after.job.lastErrorCode).toBe("RPC_UNAVAILABLE");
    expect(after.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(after.alert.publishedAt).toBeNull();
    expect(fixture.gateway.submitCalls).toHaveLength(0);
  });
});
