import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import type {
  AnchorJobState,
  AnchorStatus,
  AlertLifecycleState,
} from "../../generated/prisma/enums.js";
import { requireUuid } from "../alerts/alert-persistence.js";
import { appendAuditEvent } from "../audit/append-audit-event.js";
import type {
  AnchorConfirmation,
  AnchorDeploymentConfig,
  AnchorRequest,
  AnchorReconciliation,
  SorobanAnchorGateway,
} from "./soroban-anchor-gateway.js";
import { SorobanGatewaySubmissionError } from "./soroban-testnet-anchor-gateway.js";
import { matchesTrustedTestnetDeployment } from "./trusted-testnet-deployment.js";
import { anchorJobSelect, validateAnchorJobIntegrity, type AnchorJobRow } from "./anchor-job-integrity.js";
import { persistAnchorConfirmation } from "./anchor-job-confirmation.js";

const txHashPattern = /^[a-fA-F0-9]{64}$/u;
const STELLAR_TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
type JobState = AnchorJobState;

export interface AnchorWorkerPolicy {
  readonly leaseDurationMs: number;
  readonly retryBaseDelayMs: number;
  readonly retryMaxDelayMs: number;
  readonly pollDelayMs: number;
  /** Número máximo de fallos automáticos acumulados (conocidos o inciertos). */
  readonly maxAutomaticFailures: number;
}

export type AnchorDeploymentTrustPolicy = (
  deployment: AnchorDeploymentConfig,
) => boolean;

export interface AnchorWorkerOptions {
  readonly clock?: WorkerClock;
  readonly deploymentTrustPolicy?: AnchorDeploymentTrustPolicy;
  readonly allowOfflineGateway?: true;
}

export type AnchorWorkerResult =
  | { readonly kind: "idle" }
  | { readonly kind: "submitted"; readonly jobId: string; readonly txHash: string }
  | { readonly kind: "confirmed"; readonly jobId: string }
  | { readonly kind: "retryable"; readonly jobId: string; readonly nextAttemptAt: Date }
  | { readonly kind: "conflict"; readonly jobId: string }
  | { readonly kind: "uncertain"; readonly jobId: string; readonly code?: string }
  | { readonly kind: "lease_lost"; readonly jobId: string }
  | { readonly kind: "failed"; readonly jobId: string; readonly reason: "RETRY_LIMIT_EXHAUSTED" }
  | { readonly kind: "review_required"; readonly jobId: string; readonly reason: "RECONCILIATION_REVIEW_REQUIRED" }
  | {
      readonly kind: "unverifiable";
      readonly jobId: string;
      readonly reason: "DEPLOYMENT_UNAVAILABLE" | "JOB_INTEGRITY_FAILED";
    };

interface Claim {
  readonly id: string;
  readonly alertId: string;
  readonly state: JobState;
  readonly sourceState: JobState;
  readonly attemptCount: number;
  readonly leaseUntil: Date;
}

interface WorkerClock {
  now(): Date;
}

const systemClock: WorkerClock = { now: () => new Date() };

function validPolicy(policy: AnchorWorkerPolicy): void {
  if (!Number.isSafeInteger(policy.leaseDurationMs) || policy.leaseDurationMs < 1 ||
      policy.leaseDurationMs > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(policy.retryBaseDelayMs) || policy.retryBaseDelayMs < 1 ||
      policy.retryBaseDelayMs > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(policy.retryMaxDelayMs) ||
      policy.retryMaxDelayMs < policy.retryBaseDelayMs ||
      policy.retryMaxDelayMs > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(policy.pollDelayMs) || policy.pollDelayMs < 1 ||
      policy.pollDelayMs > 8_640_000_000_000_000 ||
      !Number.isSafeInteger(policy.maxAutomaticFailures) ||
      policy.maxAutomaticFailures < 1 || policy.maxAutomaticFailures > 1000) {
    throw new TypeError("ANCHOR_WORKER_POLICY_INVALID");
  }
}

function retryDelayFor(policy: AnchorWorkerPolicy, attemptCount: number): number {
  return Math.min(policy.retryMaxDelayMs,
    policy.retryBaseDelayMs * 2 ** Math.min(Math.max(attemptCount - 1, 0), 52));
}

function scheduledDate(now: Date, delayMs: number): Date {
  const scheduled = new Date(now.getTime() + delayMs);
  if (!Number.isFinite(scheduled.getTime())) throw new TypeError("ANCHOR_SCHEDULE_INVALID");
  return scheduled;
}

function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length &&
    Buffer.from(left).equals(Buffer.from(right));
}

function checkedTxHash(value: string): string {
  if (!txHashPattern.test(value)) throw new Error("ANCHOR_GATEWAY_RESPONSE_INVALID");
  return value.toLowerCase();
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && Buffer.from(left).equals(Buffer.from(right));
}

export class PrismaAnchorWorker {
  private readonly clock: WorkerClock;
  private readonly deploymentTrustPolicy: AnchorDeploymentTrustPolicy;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly gateway: SorobanAnchorGateway,
    private readonly policy: AnchorWorkerPolicy,
    options: AnchorWorkerOptions = {},
  ) {
    validPolicy(policy);
    if (gateway.trustDomain !== "STELLAR_TESTNET" &&
        (gateway.trustDomain !== "OFFLINE_LAB" ||
          options.allowOfflineGateway !== true || process.env.NODE_ENV !== "test")) {
      throw new TypeError("ANCHOR_OFFLINE_GATEWAY_NOT_ALLOWED");
    }
    if (options.allowOfflineGateway === true && gateway.trustDomain !== "OFFLINE_LAB") {
      throw new TypeError("ANCHOR_OFFLINE_GATEWAY_NOT_ALLOWED");
    }
    if (options.deploymentTrustPolicy && gateway.trustDomain !== "OFFLINE_LAB") {
      throw new TypeError("ANCHOR_LAB_TRUST_POLICY_REQUIRES_OFFLINE_GATEWAY");
    }
    this.clock = options.clock ?? systemClock;
    this.deploymentTrustPolicy =
      options.deploymentTrustPolicy ?? matchesTrustedTestnetDeployment;
  }

  async processNext(): Promise<AnchorWorkerResult> {
    const claim = await this.claimNext();
    if (!claim) return { kind: "idle" };

    const job = await this.loadClaimedJob(claim);
    if (!job) throw new Error("ANCHOR_JOB_NOT_FOUND_AFTER_CLAIM");
    if (!(await this.leaseIsCurrent(claim)) || job.state !== claim.state ||
        job.leaseUntil?.getTime() !== claim.leaseUntil.getTime() ||
        job.attemptCount !== claim.attemptCount) {
      return { kind: "lease_lost", jobId: claim.id };
    }
    // Un contador corrupto o ya agotado no puede habilitar nuevos envíos.
    if (!Number.isSafeInteger(job.automaticFailureCount) || job.automaticFailureCount < 0 ||
        job.automaticFailureCount >= this.policy.maxAutomaticFailures) {
      throw new Error("ANCHOR_AUTOMATIC_FAILURE_COUNT_INVALID");
    }

    const integrity = await validateAnchorJobIntegrity(this.prisma, job);
    if (!integrity) {
      await this.finishUnverifiable(claim, "JOB_INTEGRITY_FAILED");
      return { kind: "unverifiable", jobId: claim.id, reason: "JOB_INTEGRITY_FAILED" };
    }

    const deployment = await this.authorizedDeployment(job);
    if (!deployment) {
      await this.finishUnverifiable(claim, "DEPLOYMENT_UNAVAILABLE");
      return { kind: "unverifiable", jobId: claim.id, reason: "DEPLOYMENT_UNAVAILABLE" };
    }

    const request: AnchorRequest = {
      deployment,
      messageKey: Uint8Array.from(job.messageKey),
      jwsHash: Uint8Array.from(job.jwsHash),
      attemptCount: claim.attemptCount,
      leaseExpiresAt: claim.leaseUntil,
    };

    if (!(await this.leaseIsCurrent(claim)))
      return { kind: "lease_lost", jobId: claim.id };

    let reconciliation: AnchorReconciliation;
    try {
      reconciliation = await this.gateway.reconcile(this.gatewayRequest(request), job.txHash);
    } catch {
      return this.uncertainResult(claim, "RPC_UNAVAILABLE");
    }

    if (!(await this.leaseIsCurrent(claim)))
      return { kind: "lease_lost", jobId: claim.id };

    const reconciled = await this.handleReconciliation(claim, job, request, reconciliation);
    if (reconciled) return reconciled;

    if (!(await this.leaseIsCurrent(claim)))
      return { kind: "lease_lost", jobId: claim.id };

    const revalidatedDeployment = await this.authorizedDeployment(job);
    if (!revalidatedDeployment || !this.sameDeployment(revalidatedDeployment, request.deployment)) {
      await this.finishUnverifiable(claim, "DEPLOYMENT_UNAVAILABLE");
      return { kind: "unverifiable", jobId: claim.id, reason: "DEPLOYMENT_UNAVAILABLE" };
    }

    let submitted;
    try {
      submitted = await this.gateway.submit(this.gatewayRequest(request));
    } catch (error) {
      const code = error instanceof SorobanGatewaySubmissionError &&
        /^[A-Z][A-Z0-9_]{2,48}$/u.test(error.code)
        ? `${error.phase}_${error.code}`
        : "RESULT_UNCERTAIN";
      return this.uncertainResult(claim, code, true);
    }
    if (submitted.kind === "unknown") {
      return this.uncertainResult(claim, submitted.code);
    }
    if (submitted.kind === "retryable_failure") {
      return this.markRetryable(claim, submitted.code, job.automaticFailureCount);
    }
    if (!this.validSubmissionReceipt(submitted.receipt, request)) {
      return this.uncertainResult(claim, "RESULT_UNCERTAIN");
    }
    const txHash = checkedTxHash(submitted.receipt.txHash);
    await this.markSubmitted(claim, txHash);
    return { kind: "submitted", jobId: claim.id, txHash };
  }

  private async claimNext(): Promise<Claim | null> {
    const now = this.clock.now();
    const leaseUntil = scheduledDate(now, this.policy.leaseDurationMs);
    return this.prisma.$transaction(async (tx) => {
      const candidate = await tx.anchorJob.findFirst({
        where: {
          OR: [
            ...(["PENDING", "RETRYABLE", "SUBMITTED"] as const).map((state) => ({
              state,
              AND: [
                { OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
                { OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
              ],
            })),
            { state: "LEASED", OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
          ],
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true, alertId: true, state: true, leaseUntil: true, nextAttemptAt: true, attemptCount: true },
      });
      if (!candidate) return null;
      requireUuid(candidate.id);
      requireUuid(candidate.alertId);
      if (
          !Number.isSafeInteger(candidate.attemptCount) || candidate.attemptCount < 0 ||
          candidate.attemptCount >= 2_147_483_647) {
        throw new Error("ANCHOR_JOB_ATTEMPT_COUNT_INVALID");
      }
      const claimedState = candidate.state === "SUBMITTED" ? "SUBMITTED" : "LEASED";
      const updated = await tx.anchorJob.updateMany({
        where: {
          id: candidate.id,
          alertId: candidate.alertId,
          state: candidate.state,
          leaseUntil: candidate.leaseUntil,
          nextAttemptAt: candidate.nextAttemptAt,
          attemptCount: candidate.attemptCount,
        },
        data: {
          state: claimedState,
          attemptCount: { increment: 1 },
          leaseUntil,
          nextAttemptAt: null,
        },
      });
      if (updated.count !== 1) return null;
      if (candidate.state === "RETRYABLE") {
        const alertUpdated = await tx.alert.updateMany({
          where: {
            id: candidate.alertId,
            lifecycleState: "SIGNED_PENDING_ANCHOR",
            anchorStatus: "RETRYABLE_ERROR",
          },
          data: { anchorStatus: "PENDING" },
        });
        if (alertUpdated.count !== 1) throw new Error("ANCHOR_ALERT_TRANSITION_FAILED");
      }
      await appendAuditEvent(tx, {
        actorId: null,
        action: "ANCHOR_JOB_CLAIMED",
        objectType: "anchor_job",
        objectId: candidate.id,
        redactedDetails: {
          status: `${candidate.state}_TO_${claimedState}`,
          result: "CLAIMED",
          attemptCount: String(candidate.attemptCount + 1),
        },
        occurredAt: now,
      });
      return {
        id: candidate.id,
        alertId: candidate.alertId,
        state: claimedState,
        sourceState: candidate.state,
        attemptCount: candidate.attemptCount + 1,
        leaseUntil,
      };
    }, { isolationLevel: "Serializable" });
  }

  private async loadClaimedJob(claim: Claim): Promise<AnchorJobRow | null> {
    return this.prisma.anchorJob.findUnique({
      where: { id: claim.id },
      select: anchorJobSelect,
    });
  }

  private async authorizedDeployment(job: AnchorJobRow): Promise<AnchorDeploymentConfig | null> {
    const active = await this.prisma.anchorDeployment.findMany({
      where: { state: "ACTIVE", network: "TESTNET" },
      orderBy: { generation: "desc" },
      take: 2,
      select: {
        id: true, network: true, networkPassphrase: true, contractId: true, wasmHash: true,
        adminPublicAddress: true, generation: true, state: true, trustedConfigVersion: true,
      },
    });
    const deployment = job.deployment;
    const activeDeployment = active[0];
    if (active.length !== 1 || !activeDeployment || activeDeployment.id !== job.deploymentId ||
        activeDeployment.network !== deployment.network ||
        activeDeployment.networkPassphrase !== deployment.networkPassphrase ||
        activeDeployment.contractId !== deployment.contractId ||
        activeDeployment.wasmHash !== deployment.wasmHash ||
        activeDeployment.adminPublicAddress !== deployment.adminPublicAddress ||
        activeDeployment.generation !== deployment.generation ||
        activeDeployment.state !== deployment.state ||
        activeDeployment.trustedConfigVersion !== deployment.trustedConfigVersion ||
        deployment.id !== job.deploymentId || deployment.network !== "TESTNET" ||
        deployment.state !== "ACTIVE" || !deployment.contractId ||
        !/^C[A-Z2-7]{55}$/u.test(deployment.contractId) ||
        deployment.networkPassphrase !== STELLAR_TESTNET_PASSPHRASE ||
        !/^[a-fA-F0-9]{64}$/u.test(deployment.wasmHash) ||
        !/^G[A-Z2-7]{55}$/u.test(deployment.adminPublicAddress) ||
        !deployment.trustedConfigVersion ||
        !Number.isSafeInteger(deployment.generation) || deployment.generation < 1 ||
        !this.deploymentTrustPolicy(deployment as AnchorDeploymentConfig)) {
      return null;
    }
    return {
      id: deployment.id,
      network: "TESTNET",
      networkPassphrase: deployment.networkPassphrase,
      contractId: deployment.contractId,
      wasmHash: deployment.wasmHash,
      adminPublicAddress: deployment.adminPublicAddress,
      generation: deployment.generation,
      trustedConfigVersion: deployment.trustedConfigVersion,
    };
  }

  private gatewayRequest(request: AnchorRequest): AnchorRequest {
    return {
      ...request,
      deployment: { ...request.deployment },
      messageKey: Uint8Array.from(request.messageKey),
      jwsHash: Uint8Array.from(request.jwsHash),
      leaseExpiresAt: new Date(request.leaseExpiresAt),
    };
  }

  private sameDeployment(left: AnchorDeploymentConfig, right: AnchorDeploymentConfig): boolean {
    return left.id === right.id && left.network === right.network &&
      left.networkPassphrase === right.networkPassphrase && left.contractId === right.contractId &&
      left.wasmHash === right.wasmHash && left.adminPublicAddress === right.adminPublicAddress &&
      left.generation === right.generation && left.trustedConfigVersion === right.trustedConfigVersion;
  }

  private async handleReconciliation(
    claim: Claim,
    job: AnchorJobRow,
    request: AnchorRequest,
    result: AnchorReconciliation,
  ): Promise<AnchorWorkerResult | null> {
    if (result.kind === "unknown") {
      return this.uncertainResult(claim, result.code);
    }
    if (result.kind === "matching_read") {
      return this.uncertainResult(claim, "RESULT_UNCERTAIN");
    }
    if (result.kind === "conflict") {
      if (!this.matchesTrustedIdentity(result, request) ||
          sameBytes(result.observedContractHash, request.jwsHash)) {
        return this.uncertainResult(claim, "RESULT_UNCERTAIN");
      }
      await this.finishConflict(claim);
      return { kind: "conflict", jobId: claim.id };
    }
    if (result.kind === "confirmed") {
      if (!this.validConfirmation(result.evidence, request) ||
          (job.txHash !== null && result.evidence.txHash !== null &&
            job.txHash.toLowerCase() !== result.evidence.txHash.toLowerCase())) {
        return this.uncertainResult(claim, "RESULT_UNCERTAIN");
      }
      await this.finishConfirmed(claim, result.evidence);
      return { kind: "confirmed", jobId: claim.id };
    }
    if (result.kind === "submitted") {
      if (!this.validSubmissionReceipt(result.receipt, request)) {
        return this.uncertainResult(claim, "RESULT_UNCERTAIN");
      }
      const txHash = checkedTxHash(result.receipt.txHash);
      if (job.txHash !== null && job.txHash.toLowerCase() !== txHash) {
        return this.uncertainResult(claim, "RESULT_UNCERTAIN");
      }
      await this.markSubmitted(claim, txHash);
      return { kind: "submitted", jobId: claim.id, txHash };
    }
    if (result.kind === "absent") {
      if (!this.matchesTrustedIdentity(result, request)) {
        return this.uncertainResult(claim, "RESULT_UNCERTAIN");
      }
      const transactionSafe = result.priorTransactionStatus === "NOT_APPLICABLE" ||
        result.priorTransactionStatus === "FAILED" ||
        result.priorTransactionStatus === "NOT_FOUND_AFTER_RECONCILIATION";
      const firstAttemptWithoutPriorTx = claim.sourceState === "PENDING" &&
        claim.attemptCount === 1 && job.txHash === null;
      if (!transactionSafe || (!firstAttemptWithoutPriorTx &&
          result.priorTransactionStatus !== "FAILED" &&
          result.priorTransactionStatus !== "NOT_FOUND_AFTER_RECONCILIATION")) {
        return this.uncertainResult(claim, "RESULT_UNCERTAIN");
      }
      return null;
    }
    return null;
  }

  private matchesTrustedIdentity(
    result: {
      readonly deploymentId: string;
      readonly contractId: string;
      readonly messageKey: Uint8Array;
    },
    request: AnchorRequest,
  ): boolean {
    return result.deploymentId === request.deployment.id &&
      result.contractId === request.deployment.contractId &&
      sameBytes(result.messageKey, request.messageKey);
  }

  private validSubmissionReceipt(
    receipt: {
      readonly deploymentId: string;
      readonly contractId: string;
      readonly messageKey: Uint8Array;
      readonly txHash: string;
      readonly transactionStatus: "PENDING";
    },
    request: AnchorRequest,
  ): boolean {
    return this.matchesTrustedIdentity(receipt, request) &&
      txHashPattern.test(receipt.txHash) &&
      receipt.transactionStatus === "PENDING";
  }

  private validConfirmation(evidence: AnchorConfirmation, request: AnchorRequest): boolean {
    const txHashValid = txHashPattern.test(evidence.txHash);
    const ledgerValid = evidence.confirmedLedger > 0n;
    const timeValid = evidence.verifiedAt instanceof Date &&
      Number.isFinite(evidence.verifiedAt.getTime()) &&
      evidence.verifiedAt.getTime() <= this.clock.now().getTime();
    return evidence.source === "transaction_and_readback" &&
      evidence.transactionStatus === "SUCCESS" && timeValid && txHashValid && ledgerValid &&
      evidence.contractReadMatched === true &&
      evidence.deploymentId === request.deployment.id &&
      evidence.contractId === request.deployment.contractId &&
      sameBytes(evidence.messageKey, request.messageKey) &&
      sameBytes(evidence.jwsHash, request.jwsHash);
  }

  private async markSubmitted(claim: Claim, txHash: string): Promise<void> {
    const now = this.clock.now();
    const nextAttemptAt = scheduledDate(now, this.policy.pollDelayMs);
    await this.transition(claim, {
      jobState: "SUBMITTED",
      alertStatus: "SUBMITTED",
      txHash,
      nextAttemptAt,
      auditAction: "ANCHOR_JOB_SUBMITTED",
      auditStatus: "LEASED_TO_SUBMITTED",
      auditResult: "TX_PENDING",
      occurredAt: now,
    });
  }

  private async markRetryable(
    claim: Claim,
    code: "RPC_REJECTED" | "SIMULATION_FAILED",
    priorAutomaticFailures: number,
  ): Promise<AnchorWorkerResult> {
    const now = this.clock.now();
    // retryable_failure solo se devuelve si el gateway sabe que NO se aceptó la transacción.
    // Si se agotó el presupuesto, no hay otro envío automático ni publicación.
    if (priorAutomaticFailures + 1 >= this.policy.maxAutomaticFailures) {
      await this.transition(claim, {
        jobState: "FAILED",
        alertStatus: "FAILED",
        txHash: undefined, // Conservar txHash previo para auditoría/reconciliación manual.
        nextAttemptAt: null,
        lastErrorCode: "RETRY_LIMIT_EXHAUSTED",
        sanitizedError: code,
        auditAction: "ANCHOR_JOB_RETRY_EXHAUSTED",
        auditStatus: "LEASED_TO_FAILED",
        auditResult: code,
        occurredAt: now,
        incrementAutomaticFailureCount: true,
      });
      return { kind: "failed", jobId: claim.id, reason: "RETRY_LIMIT_EXHAUSTED" };
    }
    const nextAttemptAt = scheduledDate(now, retryDelayFor(this.policy, claim.attemptCount));
    await this.transition(claim, {
      jobState: "RETRYABLE",
      alertStatus: "RETRYABLE_ERROR",
      txHash: undefined,
      nextAttemptAt,
      lastErrorCode: code,
      sanitizedError: code,
      auditAction: "ANCHOR_JOB_RETRYABLE",
      auditStatus: "LEASED_TO_RETRYABLE",
      auditResult: code,
      occurredAt: now,
      incrementAutomaticFailureCount: true,
    });
    return { kind: "retryable", jobId: claim.id, nextAttemptAt };
  }

  private async finishConfirmed(
    claim: Claim,
    evidence: AnchorConfirmation,
  ): Promise<void> {
    await persistAnchorConfirmation(
      this.prisma, claim, evidence, null, this.clock.now(),
    );
  }

  private async finishConflict(claim: Claim): Promise<void> {
    const now = this.clock.now();
    await this.transition(claim, {
      jobState: "CONFLICT",
      alertStatus: "CONFLICT",
      txHash: undefined,
      nextAttemptAt: null,
      lastErrorCode: "ONCHAIN_HASH_CONFLICT",
      sanitizedError: "ONCHAIN_HASH_CONFLICT",
      auditAction: "ANCHOR_JOB_CONFLICT",
      auditStatus: "LEASED_TO_CONFLICT",
      auditResult: "HASH_MISMATCH",
      occurredAt: now,
    });
  }

  private async finishUnverifiable(
    claim: Claim,
    reason: "DEPLOYMENT_UNAVAILABLE" | "JOB_INTEGRITY_FAILED",
  ): Promise<void> {
    const now = this.clock.now();
    await this.transition(claim, {
      jobState: "UNVERIFIABLE",
      alertStatus: "UNVERIFIABLE",
      txHash: undefined,
      nextAttemptAt: null,
      lastErrorCode: reason,
      sanitizedError: reason,
      auditAction: "ANCHOR_JOB_UNVERIFIABLE",
      auditStatus: "LEASED_TO_UNVERIFIABLE",
      auditResult: reason,
      occurredAt: now,
      allowedLifecycleStates: ["SIGNED_PENDING_ANCHOR", "PUBLISHED"],
      allowedAnchorStatuses: ["PENDING", "SUBMITTED", "RETRYABLE_ERROR", "CONFIRMED", "UNVERIFIABLE"],
    });
  }

  private async uncertainResult(
    claim: Claim,
    code: string,
    includeCode = false,
  ): Promise<AnchorWorkerResult> {
    const reviewRequired = await this.recordUncertain(claim, code);
    if (reviewRequired) {
      return { kind: "review_required", jobId: claim.id, reason: "RECONCILIATION_REVIEW_REQUIRED" };
    }
    return includeCode ? { kind: "uncertain", jobId: claim.id, code } :
      { kind: "uncertain", jobId: claim.id };
  }

  private async recordUncertain(claim: Claim, code: string): Promise<boolean> {
    if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) {
      throw new Error("ANCHOR_FAILURE_CODE_INVALID");
    }
    const now = this.clock.now();
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.anchorJob.findUnique({
        where: { id: claim.id },
        select: { state: true, leaseUntil: true, automaticFailureCount: true },
      });
      if (!this.ownsLease(current, claim)) throw new Error("ANCHOR_JOB_LEASE_LOST");
      if (!Number.isSafeInteger(current.automaticFailureCount) || current.automaticFailureCount < 0) {
        throw new Error("ANCHOR_AUTOMATIC_FAILURE_COUNT_INVALID");
      }
      const reviewRequired = current.automaticFailureCount + 1 >= this.policy.maxAutomaticFailures;
      const updated = await tx.anchorJob.updateMany({
        where: { id: claim.id, state: current.state, leaseUntil: claim.leaseUntil,
          automaticFailureCount: current.automaticFailureCount },
        data: {
          automaticFailureCount: { increment: 1 },
          ...(reviewRequired ? { state: "REVIEW_REQUIRED" as const, leaseUntil: null, nextAttemptAt: null } : {}),
          lastErrorCode: reviewRequired ? "RECONCILIATION_REVIEW_REQUIRED" : code,
          sanitizedError: code,
        },
      });
      if (updated.count !== 1) throw new Error("ANCHOR_JOB_LEASE_LOST");
      if (reviewRequired) {
        const alertUpdated = await tx.alert.updateMany({
          where: { id: claim.alertId, lifecycleState: "SIGNED_PENDING_ANCHOR",
            anchorStatus: { in: ["PENDING", "SUBMITTED", "RETRYABLE_ERROR"] } },
          data: { anchorStatus: "REVIEW_REQUIRED" },
        });
        if (alertUpdated.count !== 1) throw new Error("ANCHOR_ALERT_TRANSITION_FAILED");
      }
      await appendAuditEvent(tx, {
        actorId: null,
        action: reviewRequired ? "ANCHOR_JOB_REVIEW_REQUIRED" : "ANCHOR_JOB_RESULT_UNCERTAIN",
        objectType: "anchor_job",
        objectId: claim.id,
        redactedDetails: {
          status: reviewRequired ? `${current.state}_TO_REVIEW_REQUIRED` :
            `${current.state}_RECONCILIATION_REQUIRED`,
          result: code,
          attemptCount: String(claim.attemptCount),
          automaticFailureCount: String(current.automaticFailureCount + 1),
        },
        occurredAt: now,
      });
      return reviewRequired;
    }, { isolationLevel: "Serializable" });
  }

  private async transition(
    claim: Claim,
    input: {
      readonly jobState: JobState;
      readonly alertStatus: AnchorStatus;
      readonly txHash: string | null | undefined;
      readonly nextAttemptAt: Date | null;
      readonly lastErrorCode?: string | null;
      readonly sanitizedError?: string | null;
      readonly incrementAutomaticFailureCount?: true;
      readonly auditAction: string;
      readonly auditStatus: string;
      readonly auditResult: string;
      readonly occurredAt: Date;
      readonly allowedLifecycleStates?: readonly AlertLifecycleState[];
      readonly allowedAnchorStatuses?: readonly AnchorStatus[];
    },
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.anchorJob.findUnique({
        where: { id: claim.id },
        select: { state: true, leaseUntil: true },
      });
      if (!this.ownsLease(current, claim)) throw new Error("ANCHOR_JOB_LEASE_LOST");
      const data: Prisma.AnchorJobUpdateManyMutationInput = {
        state: input.jobState,
        leaseUntil: null,
        nextAttemptAt: input.nextAttemptAt,
        ...(input.txHash !== undefined ? { txHash: input.txHash } : {}),
        ...(input.lastErrorCode !== undefined ? { lastErrorCode: input.lastErrorCode } : {}),
        ...(input.sanitizedError !== undefined ? { sanitizedError: input.sanitizedError } : {}),
        ...(input.incrementAutomaticFailureCount ? { automaticFailureCount: { increment: 1 } } : {}),
      };
      const updated = await tx.anchorJob.updateMany({
        where: { id: claim.id, state: current.state, leaseUntil: claim.leaseUntil },
        data,
      });
      if (updated.count !== 1) throw new Error("ANCHOR_JOB_LEASE_LOST");
      const alertUpdated = await tx.alert.updateMany({
        where: {
          id: claim.alertId,
          lifecycleState: input.allowedLifecycleStates
            ? { in: [...input.allowedLifecycleStates] }
            : "SIGNED_PENDING_ANCHOR",
          anchorStatus: {
            in: input.allowedAnchorStatuses
              ? [...input.allowedAnchorStatuses]
              : ["PENDING", "SUBMITTED", "RETRYABLE_ERROR"],
          },
        },
        data: { anchorStatus: input.alertStatus },
      });
      if (alertUpdated.count !== 1) throw new Error("ANCHOR_ALERT_TRANSITION_FAILED");
      await appendAuditEvent(tx, {
        actorId: null,
        action: input.auditAction,
        objectType: "anchor_job",
        objectId: claim.id,
        redactedDetails: {
          status: input.auditStatus,
          result: input.auditResult,
          attemptCount: String(claim.attemptCount),
        },
        occurredAt: input.occurredAt,
      });
    }, { isolationLevel: "Serializable" });
  }

  private ownsLease(
    current: { readonly state: JobState; readonly leaseUntil: Date | null } | null,
    claim: Claim,
  ): current is { readonly state: JobState; readonly leaseUntil: Date } {
    return current !== null && current.state === claim.state && current.leaseUntil !== null &&
      current.leaseUntil.getTime() === claim.leaseUntil.getTime();
  }

  private async leaseIsCurrent(claim: Claim): Promise<boolean> {
    const current = await this.prisma.anchorJob.findUnique({
      where: { id: claim.id },
      select: { state: true, leaseUntil: true },
    });
    return this.ownsLease(current, claim) && claim.leaseUntil.getTime() > this.clock.now().getTime();
  }
}
