import { exportJWK, generateKeyPair } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../src/generated/prisma/client.js";
import { buildDraftPayload } from "../../src/modules/alerts/alert-payload.js";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { identity, input } from "../alerts/alert-fixtures.js";
import {
  PrismaAnchorWorker,
  type AnchorDeploymentTrustPolicy,
  type AnchorWorkerOptions,
} from "../../src/modules/anchor/anchor-worker.js";
import { SorobanGatewaySubmissionError } from "../../src/modules/anchor/soroban-testnet-anchor-gateway.js";
import type {
  AnchorConfirmation,
  AnchorDeploymentConfig,
  AnchorRequest,
  AnchorSubmissionReceipt,
  SorobanAnchorGateway,
} from "../../src/modules/anchor/soroban-anchor-gateway.js";
import { JoseAlertSigner } from "../../src/modules/signing/jose-alert-signer.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";

const jobId = "00000000-0000-4000-8000-000000000011";
const alertId = "00000000-0000-4000-8000-000000000012";
const deploymentId = "00000000-0000-4000-8000-000000000013";
const kid = "sigae-anchor-test-key";
const startedAt = new Date("2026-10-25T16:00:00.000Z");
const txHash = "ab".repeat(32);
const policy = {
  leaseDurationMs: 30_000,
  retryBaseDelayMs: 1_000,
  retryMaxDelayMs: 8_000,
  pollDelayMs: 2_000,
  maxAutomaticFailures: 3,
};

type FakeJobState = {
  id: string;
  alertId: string;
  deploymentId: string;
  messageKey: Uint8Array;
  jwsHash: Uint8Array;
  state: "PENDING" | "LEASED" | "SUBMITTED" | "RETRYABLE" | "CONFIRMED" | "CONFLICT" | "UNVERIFIABLE" | "FAILED" | "REVIEW_REQUIRED";
  txHash: string | null;
  confirmedLedger: bigint | null;
  attemptCount: number;
  automaticFailureCount: number;
  nextAttemptAt: Date | null;
  leaseUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type FakeAlert = {
  id: string;
  sender: string;
  identifier: string;
  sentText: string;
  kind: "Alert";
  lifecycleState: "SIGNED_PENDING_ANCHOR" | "PUBLISHED";
  anchorStatus: "PENDING" | "SUBMITTED" | "RETRYABLE_ERROR" | "CONFIRMED" | "CONFLICT" | "UNVERIFIABLE" | "FAILED" | "REVIEW_REQUIRED";
  frozenPayload: Uint8Array;
  payloadSha256: Uint8Array;
  jwsCompact: string;
  kid: string;
  messageKey: Uint8Array;
  jwsHash: Uint8Array;
  publishedAt: Date | null;
  createdAt: Date;
};

type FakeState = {
  job: FakeJobState;
  alert: FakeAlert;
  deployment: {
    id: string;
    network: "TESTNET";
    networkPassphrase: string;
    contractId: string;
    wasmHash: string;
    adminPublicAddress: string;
    generation: number;
    state: "ACTIVE" | "RETIRED";
    trustedConfigVersion: string;
  };
  key: {
    kid: string;
    publicJwk: Awaited<ReturnType<typeof exportJWK>>;
    status: "ACTIVE" | "RETIRED" | "REVOKED";
    validFrom: Date;
    retiredAt: Date | null;
    revokedAt: Date | null;
  };
  audits: Array<{ action: string; objectId: string; redactedDetails: Record<string, unknown> }>;
  auditSeq: bigint;
  auditHash: Uint8Array;
  failJobTransitionTo?: string;
  failAuditAction?: string;
};

function bytesMatch(actual: unknown, expected: Uint8Array): boolean {
  return actual instanceof Uint8Array && Buffer.from(actual).equals(Buffer.from(expected));
}

function dateMatches(actual: unknown, expected: unknown): boolean {
  if (actual instanceof Date && expected instanceof Date) return actual.getTime() === expected.getTime();
  return actual === expected;
}

function matches(actual: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === "AND") return (expected as Record<string, unknown>[]).every((part) => matches(actual, part));
    if (key === "OR") return (expected as Record<string, unknown>[]).some((part) => matches(actual, part));
    if (expected && typeof expected === "object" && !(expected instanceof Date) &&
        !Array.isArray(expected) && !("length" in expected)) {
      const condition = expected as Record<string, unknown>;
      if ("in" in condition) return (condition["in"] as unknown[]).includes(actual[key]);
      if ("lte" in condition) return actual[key] instanceof Date &&
        (actual[key] as Date).getTime() <= (condition["lte"] as Date).getTime();
    }
    if (actual[key] instanceof Uint8Array && expected instanceof Uint8Array)
      return bytesMatch(actual[key], expected);
    return dateMatches(actual[key], expected);
  });
}

async function fixture(options: {
  jobState?: FakeJobState["state"];
  alertStatus?: FakeAlert["anchorStatus"];
  lifecycleState?: FakeAlert["lifecycleState"];
  corruptJwsHash?: boolean;
  corruptJws?: boolean;
  corruptMessageKey?: boolean;
  syntheticDeployment?: boolean;
  activeDeployments?: number;
  deploymentState?: FakeState["deployment"]["state"];
  existingTxHash?: string | null;
  leaseUntil?: Date | null;
  attemptCount?: number;
  automaticFailureCount?: number;
} = {}, workerOptions: AnchorWorkerOptions = {}) {
  const pair = await generateKeyPair("ES256");
  const publicJwk = await exportJWK(pair.publicKey);
  const payload = buildDraftPayload(validateAlertInput(input, identity.sent), identity);
  const jwsCompact = await new JoseAlertSigner(pair.privateKey, kid).sign(payload.payloadBytes);
  const jwsHash = calculateJwsHash(jwsCompact);
  if (options.corruptJwsHash) jwsHash[0] = jwsHash[0]! ^ 0xff;
  const messageKey = calculateMessageKey(identity);
  const storedMessageKey = new Uint8Array(messageKey);
  if (options.corruptMessageKey) storedMessageKey[0] = storedMessageKey[0]! ^ 0xff;
  const storedJws = options.corruptJws
    ? `${jwsCompact.slice(0, -1)}${jwsCompact.endsWith("A") ? "B" : "A"}`
    : jwsCompact;
  const initialState: FakeState = {
    job: {
      id: jobId, alertId, deploymentId, messageKey: storedMessageKey,
      jwsHash: new Uint8Array(jwsHash), state: options.jobState ?? "PENDING",
      txHash: options.existingTxHash ?? null, confirmedLedger: null, attemptCount: options.attemptCount ?? 0,
      automaticFailureCount: options.automaticFailureCount ?? 0,
      nextAttemptAt: null, leaseUntil: options.leaseUntil ?? null,
      createdAt: startedAt, updatedAt: startedAt,
    },
    alert: {
      id: alertId, sender: identity.sender, identifier: identity.identifier, sentText: identity.sent,
      kind: "Alert", lifecycleState: options.lifecycleState ?? "SIGNED_PENDING_ANCHOR",
      anchorStatus: options.alertStatus ?? "PENDING",
      frozenPayload: new Uint8Array(payload.payloadBytes),
      payloadSha256: new Uint8Array(payload.payloadDigest),
      jwsCompact: storedJws, kid, messageKey: new Uint8Array(messageKey),
      jwsHash: options.corruptJwsHash ? calculateJwsHash(storedJws) : new Uint8Array(jwsHash),
      publishedAt: null, createdAt: new Date(startedAt.getTime() - 30_000),
    },
    deployment: {
      id: deploymentId,
      network: "TESTNET",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: options.syntheticDeployment
        ? `C${"A".repeat(55)}`
        : "CAQLM6JQLLWCNZ5JSZRQ522VAL34DU2C7HXTLLQU7GXNGNLDLDETQZS5",
      wasmHash: options.syntheticDeployment
        ? "ab".repeat(32)
        : "90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f",
      adminPublicAddress: options.syntheticDeployment
        ? `G${"B".repeat(55)}`
        : "GDTTA7YMMQGV3NZ37VBKIIQAVG5NGLCCVMEBKVPTGAPTPRWH3E2AXNNA",
      generation: 1,
      state: options.deploymentState ?? "ACTIVE",
      trustedConfigVersion: options.syntheticDeployment
        ? "SIMULACRO-M5-POSTGRES-v1-unit-test"
        : "test-config-v1",
    },
    key: {
      kid, publicJwk, status: "ACTIVE", validFrom: new Date(startedAt.getTime() - 60_000),
      retiredAt: null, revokedAt: null,
    },
    audits: [],
    auditSeq: 0n,
    auditHash: new Uint8Array(32),
  };
  let state = structuredClone(initialState);
  let currentTime = new Date(startedAt);
  let activeDeployments = options.activeDeployments ?? 1;

  function makeTransaction(txState: FakeState) {
    const whereMatches = (row: Record<string, unknown>, where: Record<string, unknown>) =>
      matches(row, where);
    return {
      $queryRaw: vi.fn(async () => [{ last_seq: txState.auditSeq, last_hash: txState.auditHash }]),
      auditEvent: {
        create: vi.fn(async ({ data }: { data: {
          seq: bigint; action: string; objectId: string; redactedDetails: Record<string, unknown>;
          eventHash: Uint8Array;
        } }) => {
          if (txState.failAuditAction === data.action) throw new Error("synthetic audit failure");
          txState.auditSeq = data.seq;
          txState.auditHash = new Uint8Array(data.eventHash);
          txState.audits.push({
            action: data.action, objectId: data.objectId, redactedDetails: data.redactedDetails,
          });
          return data;
        }),
      },
      auditChainState: {
        update: vi.fn(async ({ data }: { data: { lastSeq: bigint; lastHash: Uint8Array } }) => {
          txState.auditSeq = data.lastSeq;
          txState.auditHash = new Uint8Array(data.lastHash);
          return data;
        }),
      },
      anchorJob: {
        findFirst: vi.fn(async () => {
          const job = txState.job;
          const eligibleTime = (value: Date | null) => value === null || value.getTime() <= currentTime.getTime();
          const eligible = job.state === "PENDING" || job.state === "RETRYABLE" ||
            job.state === "SUBMITTED" || (job.state === "LEASED" &&
              job.leaseUntil !== null && job.leaseUntil.getTime() <= currentTime.getTime());
          if (!eligible || (job.state !== "LEASED" &&
              (!eligibleTime(job.leaseUntil) || !eligibleTime(job.nextAttemptAt)))) return null;
          return {
            id: job.id, alertId: job.alertId, state: job.state, leaseUntil: job.leaseUntil,
            nextAttemptAt: job.nextAttemptAt, attemptCount: job.attemptCount,
            automaticFailureCount: job.automaticFailureCount,
          };
        }),
        updateMany: vi.fn(async ({ where, data }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!whereMatches(txState.job as unknown as Record<string, unknown>, where)) return { count: 0 };
          if (txState.failJobTransitionTo !== undefined &&
              data["state"] === txState.failJobTransitionTo) {
            throw new Error("synthetic persistence failure");
          }
          for (const [key, value] of Object.entries(data)) {
            if ((key === "attemptCount" || key === "automaticFailureCount") &&
                value && typeof value === "object" && "increment" in value) {
              txState.job[key] += (value as { increment: number }).increment;
            } else {
              Object.assign(txState.job, { [key]: value });
            }
          }
          return { count: 1 };
        }),
        findUnique: vi.fn(async ({
          where, select,
        }: { where: { id: string }; select?: Record<string, boolean> }) => {
          if (where.id !== txState.job.id) return null;
          if (select && "leaseUntil" in select && !("alert" in select))
            return { state: txState.job.state, leaseUntil: txState.job.leaseUntil,
              automaticFailureCount: txState.job.automaticFailureCount };
          return {
            ...txState.job,
            alert: txState.alert,
            deployment: txState.deployment,
          };
        }),
      },
      alert: {
        updateMany: vi.fn(async ({ where, data }: {
          where: Record<string, unknown>;
          data: Record<string, unknown>;
        }) => {
          if (!whereMatches(txState.alert as unknown as Record<string, unknown>, where)) return { count: 0 };
          Object.assign(txState.alert, data);
          return { count: 1 };
        }),
      },
    };
  }

  const outerTx = makeTransaction(state);
  let transactionQueue = Promise.resolve();
  const prisma = {
    $transaction: vi.fn(async <T>(run: (tx: typeof outerTx) => Promise<T>) => {
      let unlock: () => void = () => {};
      const previous = transactionQueue;
      transactionQueue = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      const transactionState = structuredClone(state);
      const tx = makeTransaction(transactionState);
      try {
        const result = await run(tx);
        state = transactionState;
        return result;
      } finally {
        unlock();
      }
    }),
    anchorJob: {
      findUnique: vi.fn(async ({
        where, select,
      }: { where: { id: string }; select?: Record<string, boolean> }) => {
        if (where.id !== state.job.id) return null;
        if (select && "leaseUntil" in select && !("alert" in select))
          return { state: state.job.state, leaseUntil: state.job.leaseUntil,
            automaticFailureCount: state.job.automaticFailureCount };
        return { ...state.job, alert: state.alert, deployment: state.deployment };
      }),
    },
    anchorDeployment: {
      findMany: vi.fn(async () => Array.from({
        length: state.deployment.state === "ACTIVE" ? activeDeployments : 0,
      }, () => ({
        id: state.deployment.id,
        network: state.deployment.network,
        networkPassphrase: state.deployment.networkPassphrase,
        contractId: state.deployment.contractId,
        wasmHash: state.deployment.wasmHash,
        adminPublicAddress: state.deployment.adminPublicAddress,
        generation: state.deployment.generation,
        state: state.deployment.state,
        trustedConfigVersion: state.deployment.trustedConfigVersion,
      }))),
    },
    publicKey: {
      findUnique: vi.fn(async () => state.key),
    },
  } as unknown as PrismaClient;
  const gateway = {
    trustDomain: "OFFLINE_LAB" as const,
    reconcile: vi.fn<SorobanAnchorGateway["reconcile"]>(async () => ({
      kind: "absent" as const,
      deploymentId,
      contractId: state.deployment.contractId,
      messageKey: new Uint8Array(messageKey),
      observedContractHash: null,
      priorTransactionStatus: "NOT_APPLICABLE" as const,
    })),
    submit: vi.fn<SorobanAnchorGateway["submit"]>(async (request: AnchorRequest) => ({
      kind: "submitted" as const,
      receipt: {
        deploymentId: request.deployment.id,
        contractId: request.deployment.contractId,
        messageKey: new Uint8Array(request.messageKey),
        txHash,
        transactionStatus: "PENDING" as const,
      } satisfies AnchorSubmissionReceipt,
    })),
  } satisfies SorobanAnchorGateway;
  const worker = new PrismaAnchorWorker(prisma, gateway, policy, {
    clock: { now: () => new Date(currentTime) },
    allowOfflineGateway: true,
    ...workerOptions,
  });
  return {
    worker,
    gateway,
    prisma,
    get state() { return state; },
    setActiveDeployments(value: number) { activeDeployments = value; },
    setCurrentTime(value: Date) { currentTime = new Date(value); },
    setFailure(values: { jobTransitionTo?: string; auditAction?: string }) {
      if (values.jobTransitionTo !== undefined) state.failJobTransitionTo = values.jobTransitionTo;
      if (values.auditAction !== undefined) state.failAuditAction = values.auditAction;
    },
  };
}

function confirmation(request: AnchorRequest, options: {
  hash?: Uint8Array;
  contractId?: string;
  txHash?: string;
} = {}): AnchorConfirmation {
  return {
    source: "transaction_and_readback",
    deploymentId: request.deployment.id,
    contractId: options.contractId ?? request.deployment.contractId,
    messageKey: new Uint8Array(request.messageKey),
    jwsHash: options.hash ?? new Uint8Array(request.jwsHash),
    txHash: options.txHash === undefined ? txHash : options.txHash,
    confirmedLedger: 123n,
    verifiedAt: new Date(startedAt.getTime() - 1),
    transactionStatus: "SUCCESS",
    contractReadMatched: true,
  };
}

function syntheticDeploymentConfig(): AnchorDeploymentConfig {
  return {
    id: deploymentId,
    network: "TESTNET",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: `C${"A".repeat(55)}`,
    wasmHash: "ab".repeat(32),
    adminPublicAddress: `G${"B".repeat(55)}`,
    generation: 1,
    trustedConfigVersion: "SIMULACRO-M5-POSTGRES-v1-unit-test",
  };
}

function trustOnlySyntheticDeployment(
  expected: AnchorDeploymentConfig,
): AnchorDeploymentTrustPolicy {
  return (candidate) =>
    expected.trustedConfigVersion.startsWith("SIMULACRO-M5-POSTGRES-v1-") &&
    candidate.id === expected.id &&
    candidate.network === expected.network &&
    candidate.networkPassphrase === expected.networkPassphrase &&
    candidate.contractId === expected.contractId &&
    candidate.wasmHash === expected.wasmHash &&
    candidate.adminPublicAddress === expected.adminPublicAddress &&
    candidate.generation === expected.generation &&
    candidate.trustedConfigVersion === expected.trustedConfigVersion;
}

describe("AnchorWorker M5", () => {
  it("rechaza gateways simulados sin opt-in explícito de pruebas", async () => {
    const subject = await fixture();

    expect(() => new PrismaAnchorWorker(subject.prisma, subject.gateway, policy))
      .toThrow("ANCHOR_OFFLINE_GATEWAY_NOT_ALLOWED");
  });

  it("persiste fase y código saneado cuando falla la preparación, sin publicar", async () => {
    const subject = await fixture();
    subject.gateway.submit.mockRejectedValueOnce(
      new SorobanGatewaySubmissionError("PREFLIGHT", "STELLAR_RPC_TIMEOUT"),
    );

    await expect(subject.worker.processNext()).resolves.toMatchObject({
      kind: "uncertain",
      code: "PREFLIGHT_STELLAR_RPC_TIMEOUT",
    });
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.alert.anchorStatus).not.toBe("CONFIRMED");
    expect(subject.state.audits.at(-1)?.redactedDetails["result"])
      .toBe("PREFLIGHT_STELLAR_RPC_TIMEOUT");
  });

  it("rechaza un deployment sintético con la política estricta predeterminada", async () => {
    const subject = await fixture({ syntheticDeployment: true });

    await expect(subject.worker.processNext()).resolves.toMatchObject({
      kind: "unverifiable",
      reason: "DEPLOYMENT_UNAVAILABLE",
    });
    expect(subject.gateway.reconcile).not.toHaveBeenCalled();
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.alert.anchorStatus).toBe("UNVERIFIABLE");
  });

  it("acepta el deployment sintético solo con una política explícita y exacta", async () => {
    const subject = await fixture(
      { syntheticDeployment: true },
      { deploymentTrustPolicy: trustOnlySyntheticDeployment(syntheticDeploymentConfig()) },
    );

    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "submitted" });
    expect(subject.gateway.reconcile).toHaveBeenCalledTimes(1);
    expect(subject.gateway.submit).toHaveBeenCalledTimes(1);
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "SIGNED_PENDING_ANCHOR",
      anchorStatus: "SUBMITTED",
      publishedAt: null,
    });
  });

  it("rechaza otro deployment sintético que no coincida exactamente con la política inyectada", async () => {
    const subject = await fixture(
      { syntheticDeployment: true },
      { deploymentTrustPolicy: trustOnlySyntheticDeployment(syntheticDeploymentConfig()) },
    );
    subject.state.deployment.wasmHash = "cd".repeat(32);

    await expect(subject.worker.processNext()).resolves.toMatchObject({
      kind: "unverifiable",
      reason: "DEPLOYMENT_UNAVAILABLE",
    });
    expect(subject.gateway.reconcile).not.toHaveBeenCalled();
    expect(subject.gateway.submit).not.toHaveBeenCalled();
  });

  it("impide usar la política de laboratorio con un gateway Testnet", async () => {
    const subject = await fixture({ syntheticDeployment: true });
    const testnetGateway: SorobanAnchorGateway = {
      trustDomain: "STELLAR_TESTNET",
      reconcile: async () => ({ kind: "unknown", code: "RPC_UNAVAILABLE" }),
      submit: async () => ({ kind: "unknown", code: "RESULT_UNCERTAIN" }),
    };

    expect(() => new PrismaAnchorWorker(subject.prisma, testnetGateway, policy, {
      deploymentTrustPolicy: trustOnlySyntheticDeployment(syntheticDeploymentConfig()),
    })).toThrow("ANCHOR_LAB_TRUST_POLICY_REQUIRES_OFFLINE_GATEWAY");
  });

  it("mantiene las validaciones de JWS, digest y messageKey antes de confiar en el deployment de laboratorio", async () => {
    for (const integrityOptions of [
      { corruptJws: true },
      { corruptJwsHash: true },
      { corruptMessageKey: true },
    ]) {
      const subject = await fixture(
        { ...integrityOptions, syntheticDeployment: true },
        { deploymentTrustPolicy: trustOnlySyntheticDeployment(syntheticDeploymentConfig()) },
      );

      await expect(subject.worker.processNext()).resolves.toMatchObject({
        kind: "unverifiable",
        reason: "JOB_INTEGRITY_FAILED",
      });
      expect(subject.gateway.reconcile).not.toHaveBeenCalled();
      expect(subject.gateway.submit).not.toHaveBeenCalled();
      expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    }
  });

  it("mantiene la política estricta para la configuración fijada de Testnet", async () => {
    const subject = await fixture();

    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "submitted" });
    expect(subject.gateway.submit).toHaveBeenCalledTimes(1);
  });

  it("reconcilia ausencia antes de enviar y deja la alerta sin publicar", async () => {
    const subject = await fixture();
    await expect(subject.worker.processNext()).resolves.toEqual({
      kind: "submitted", jobId, txHash,
    });

    expect(subject.gateway.reconcile).toHaveBeenCalledTimes(1);
    expect(subject.gateway.submit).toHaveBeenCalledTimes(1);
    expect(subject.state.job).toMatchObject({ state: "SUBMITTED", txHash, attemptCount: 1 });
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "SUBMITTED", publishedAt: null,
    });
    expect(subject.state.audits.map((event) => event.action)).toEqual([
      "ANCHOR_JOB_CLAIMED", "ANCHOR_JOB_SUBMITTED",
    ]);
  });

  it("publica únicamente tras confirmar y releer el hash coincidente", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "confirmed",
      evidence: confirmation(request),
    }));
    await expect(subject.worker.processNext()).resolves.toEqual({ kind: "confirmed", jobId });

    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.job).toMatchObject({ state: "CONFIRMED", confirmedLedger: 123n });
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "PUBLISHED", anchorStatus: "CONFIRMED", publishedAt: new Date(startedAt.getTime() - 1),
    });
    expect(subject.state.audits.at(-1)?.action).toBe("ANCHOR_JOB_CONFIRMED");
  });

  it("acepta SUCCESS y relectura coincidente sin requerir reenvío", async () => {
    const subject = await fixture({ jobState: "SUBMITTED", alertStatus: "SUBMITTED", existingTxHash: txHash });
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "confirmed",
      evidence: confirmation(request),
    }));
    await expect(subject.worker.processNext()).resolves.toEqual({ kind: "confirmed", jobId });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.alert.lifecycleState).toBe("PUBLISHED");
  });

  it("no publica si el gateway solo observa una lectura coincidente", async () => {
    const subject = await fixture({ jobState: "SUBMITTED", alertStatus: "SUBMITTED", existingTxHash: txHash });
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "matching_read",
      deploymentId: request.deployment.id,
      contractId: request.deployment.contractId,
      messageKey: request.messageKey,
      observedContractHash: request.jwsHash,
    }));

    await expect(subject.worker.processNext()).resolves.toEqual({ kind: "uncertain", jobId });
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.alert.anchorStatus).toBe("SUBMITTED");
  });

  it("no toma un lease vigente y no llama al gateway", async () => {
    const subject = await fixture({
      jobState: "LEASED",
      leaseUntil: new Date(startedAt.getTime() + 5_000),
    });
    await expect(subject.worker.processNext()).resolves.toEqual({ kind: "idle" });
    expect(subject.gateway.reconcile).not.toHaveBeenCalled();
  });

  it("no inicia un envío cuando el lease expira durante la reconciliación", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockImplementation(async (request) => {
      subject.setCurrentTime(request.leaseExpiresAt);
      return {
        kind: "absent",
        deploymentId: request.deployment.id,
        contractId: request.deployment.contractId,
        messageKey: new Uint8Array(request.messageKey),
        observedContractHash: null,
        priorTransactionStatus: "NOT_APPLICABLE",
      };
    });
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "lease_lost" });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
  });

  it("reclama concurrentemente una sola vez", async () => {
    const subject = await fixture();
    const results = await Promise.all([
      subject.worker.processNext(),
      subject.worker.processNext(),
    ]);
    expect(results.filter((result) => result.kind === "submitted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "idle")).toHaveLength(1);
    expect(subject.gateway.submit).toHaveBeenCalledTimes(1);
  });

  it("rechaza hashes incompatibles y no contacta el gateway", async () => {
    const subject = await fixture({ corruptJwsHash: true });
    await expect(subject.worker.processNext()).resolves.toMatchObject({
      kind: "unverifiable", reason: "JOB_INTEGRITY_FAILED",
    });
    expect(subject.gateway.reconcile).not.toHaveBeenCalled();
    expect(subject.state.job.state).toBe("UNVERIFIABLE");
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "UNVERIFIABLE",
    });
  });

  it("rechaza un JWS manipulado aunque el worker no obtenga datos del cliente", async () => {
    const subject = await fixture({ corruptJws: true });
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "unverifiable" });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
  });

  it("preserva la publicación histórica y marca la evidencia actual no verificable", async () => {
    const subject = await fixture({ lifecycleState: "PUBLISHED", alertStatus: "CONFIRMED" });
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "unverifiable" });
    expect(subject.state.alert.lifecycleState).toBe("PUBLISHED");
    expect(subject.state.alert.anchorStatus).toBe("UNVERIFIABLE");
    expect(subject.state.job.state).toBe("UNVERIFIABLE");
    expect(subject.gateway.reconcile).not.toHaveBeenCalled();
  });

  it("bloquea deployment ausente o ambiguo sin enviar transacciones", async () => {
    const absent = await fixture({ deploymentState: "RETIRED" });
    await expect(absent.worker.processNext()).resolves.toMatchObject({
      kind: "unverifiable", reason: "DEPLOYMENT_UNAVAILABLE",
    });
    expect(absent.gateway.submit).not.toHaveBeenCalled();

    const ambiguous = await fixture();
    ambiguous.setActiveDeployments(2);
    await expect(ambiguous.worker.processNext()).resolves.toMatchObject({
      kind: "unverifiable", reason: "DEPLOYMENT_UNAVAILABLE",
    });
    expect(ambiguous.gateway.reconcile).not.toHaveBeenCalled();
  });

  it.each([
    ["contractId", "C" + "A".repeat(55)],
    ["adminPublicAddress", "G" + "A".repeat(55)],
    ["wasmHash", "0".repeat(64)],
  ] as const)("rechaza %s alterado en PostgreSQL antes de usar RPC", async (field, value) => {
    const subject = await fixture();
    subject.state.deployment[field] = value;
    await expect(subject.worker.processNext()).resolves.toMatchObject({
      kind: "unverifiable", reason: "DEPLOYMENT_UNAVAILABLE",
    });
    expect(subject.gateway.reconcile).not.toHaveBeenCalled();
    expect(subject.gateway.submit).not.toHaveBeenCalled();
  });

  it("conserva LEASED si RPC es inaccesible o el resultado de envío es incierto", async () => {
    const unavailable = await fixture();
    unavailable.gateway.reconcile.mockResolvedValue({ kind: "unknown", code: "RPC_UNAVAILABLE" });
    await expect(unavailable.worker.processNext()).resolves.toMatchObject({ kind: "uncertain" });
    expect(unavailable.gateway.submit).not.toHaveBeenCalled();
    expect(unavailable.state.job).toMatchObject({ state: "LEASED", lastErrorCode: "RPC_UNAVAILABLE" });
    expect(unavailable.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");

    const uncertainSend = await fixture();
    uncertainSend.gateway.submit.mockResolvedValue({
      kind: "unknown", code: "RESULT_UNCERTAIN",
    });
    await expect(uncertainSend.worker.processNext()).resolves.toMatchObject({ kind: "uncertain" });
    expect(uncertainSend.state.job.state).toBe("LEASED");
    expect(uncertainSend.state.job.txHash).toBeNull();
  });

  it("registra fallo recuperable con backoff exponencial acotado", async () => {
    const subject = await fixture();
    subject.gateway.submit.mockResolvedValue({ kind: "retryable_failure", code: "RPC_REJECTED" });
    await expect(subject.worker.processNext()).resolves.toMatchObject({
      kind: "retryable",
      nextAttemptAt: new Date(startedAt.getTime() + policy.retryBaseDelayMs),
    });
    expect(subject.state.job).toMatchObject({
      state: "RETRYABLE", lastErrorCode: "RPC_REJECTED", sanitizedError: "RPC_REJECTED",
    });
    expect(subject.state.alert.anchorStatus).toBe("RETRYABLE_ERROR");
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");

    const capped = await fixture({
      jobState: "RETRYABLE",
      alertStatus: "RETRYABLE_ERROR",
      attemptCount: 19,
    });
    capped.gateway.submit.mockResolvedValue({ kind: "retryable_failure", code: "RPC_REJECTED" });
    capped.gateway.reconcile.mockResolvedValue({
      kind: "absent",
      deploymentId,
      contractId: capped.state.deployment.contractId,
      messageKey: new Uint8Array(capped.state.job.messageKey),
      observedContractHash: null,
      priorTransactionStatus: "FAILED",
    });
    await expect(capped.worker.processNext()).resolves.toMatchObject({
      kind: "retryable",
      nextAttemptAt: new Date(startedAt.getTime() + policy.retryMaxDelayMs),
    });
  });

  it("reconcilia antes del reintento y conserva la unicidad del job", async () => {
    const subject = await fixture({
      jobState: "RETRYABLE", alertStatus: "RETRYABLE_ERROR", attemptCount: 1,
    });
    subject.gateway.reconcile.mockResolvedValue({
      kind: "absent",
      deploymentId,
      contractId: subject.state.deployment.contractId,
      messageKey: new Uint8Array(subject.state.job.messageKey),
      observedContractHash: null,
      priorTransactionStatus: "FAILED",
    });
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "submitted" });
    expect(subject.gateway.reconcile).toHaveBeenCalledTimes(1);
    expect(subject.gateway.submit).toHaveBeenCalledTimes(1);
    expect(subject.state.job.id).toBe(jobId);
    expect(subject.state.job.attemptCount).toBe(2);
  });

  it("recupera un lease vencido solo después de reconciliar el intento previo", async () => {
    const subject = await fixture({
      jobState: "LEASED",
      leaseUntil: new Date(startedAt.getTime() - 1),
      attemptCount: 1,
    });
    subject.gateway.reconcile.mockResolvedValue({
      kind: "absent",
      deploymentId,
      contractId: subject.state.deployment.contractId,
      messageKey: new Uint8Array(subject.state.job.messageKey),
      observedContractHash: null,
      priorTransactionStatus: "NOT_FOUND_AFTER_RECONCILIATION",
    });
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "submitted" });
    expect(subject.gateway.reconcile).toHaveBeenCalledTimes(1);
    expect(subject.gateway.submit).toHaveBeenCalledTimes(1);
    expect(subject.state.job.attemptCount).toBe(2);
  });

  it("marca conflicto ante una huella distinta sin publicar ni sobrescribirla", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "conflict",
      deploymentId: request.deployment.id,
      contractId: request.deployment.contractId,
      messageKey: new Uint8Array(request.messageKey),
      observedContractHash: new Uint8Array(32).fill(9),
    }));
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "conflict" });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.job.state).toBe("CONFLICT");
    expect(subject.state.alert).toMatchObject({
      lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "CONFLICT",
    });
  });

  it("no acepta confirmación estructural incompatible", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "confirmed",
      evidence: confirmation(request, { hash: new Uint8Array(32).fill(3) }),
    }));
    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "uncertain" });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.job.state).toBe("LEASED");
  });

  it("la confianza de laboratorio tampoco publica sin relectura coincidente", async () => {
    const subject = await fixture(
      { syntheticDeployment: true },
      { deploymentTrustPolicy: trustOnlySyntheticDeployment(syntheticDeploymentConfig()) },
    );
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "confirmed",
      evidence: confirmation(request, { hash: new Uint8Array(32).fill(3) }),
    }));

    await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "uncertain" });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.alert.anchorStatus).toBe("PENDING");
    expect(subject.state.alert.publishedAt).toBeNull();
  });

  it("no marca publicada si falla la persistencia o la auditoría de confirmación", async () => {
    const failedPersistence = await fixture();
    failedPersistence.setFailure({ jobTransitionTo: "CONFIRMED" });
    failedPersistence.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "confirmed", evidence: confirmation(request),
    }));
    await expect(failedPersistence.worker.processNext()).rejects.toThrow("synthetic persistence failure");
    expect(failedPersistence.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(failedPersistence.state.job.state).toBe("LEASED");

    const failedAudit = await fixture();
    failedAudit.gateway.reconcile.mockImplementation(async (request) => {
      failedAudit.setFailure({ auditAction: "ANCHOR_JOB_CONFIRMED" });
      return { kind: "confirmed", evidence: confirmation(request) };
    });
    await expect(failedAudit.worker.processNext()).rejects.toThrow("synthetic audit failure");
    expect(failedAudit.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(failedAudit.state.job.state).toBe("LEASED");
    expect(failedAudit.state.audits.map((event) => event.action)).toEqual(["ANCHOR_JOB_CLAIMED"]);
  });

  it("exige relectura confirmada y no publica por sendTransaction ni hash tx", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockResolvedValue({
      kind: "absent",
      deploymentId,
      contractId: subject.state.deployment.contractId,
      messageKey: new Uint8Array(subject.state.job.messageKey),
      observedContractHash: null,
      priorTransactionStatus: "NOT_APPLICABLE",
    });
    subject.gateway.submit.mockResolvedValue({
      kind: "submitted",
      receipt: {
        deploymentId,
        contractId: subject.state.deployment.contractId,
        messageKey: new Uint8Array(subject.state.job.messageKey),
        txHash,
        transactionStatus: "PENDING",
      },
    });
    await subject.worker.processNext();
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
    expect(subject.state.alert.anchorStatus).toBe("SUBMITTED");
  });
  it("PB3: detiene envíos tras 3 fallos recuperables y nunca publica", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "absent",
      deploymentId: request.deployment.id,
      contractId: request.deployment.contractId,
      messageKey: new Uint8Array(request.messageKey),
      observedContractHash: null,
      priorTransactionStatus: request.attemptCount === 1
        ? "NOT_APPLICABLE" : "NOT_FOUND_AFTER_RECONCILIATION",
    }));
    subject.gateway.submit.mockResolvedValue({ kind: "retryable_failure", code: "RPC_REJECTED" });

    for (let i = 0; i < 3; i++) {
      subject.setCurrentTime(new Date(startedAt.getTime() + i * 10_000));
      await expect(subject.worker.processNext()).resolves.toMatchObject({
        kind: i === 2 ? "failed" : "retryable",
      });
      expect(subject.state.job.automaticFailureCount).toBe(i + 1);
    }
    expect(subject.state.job).toMatchObject({ state: "FAILED", nextAttemptAt: null,
      lastErrorCode: "RETRY_LIMIT_EXHAUSTED" });
    expect(subject.state.alert).toMatchObject({ lifecycleState: "SIGNED_PENDING_ANCHOR",
      anchorStatus: "FAILED", publishedAt: null });
    subject.setCurrentTime(new Date(startedAt.getTime() + 100_000));
    await expect(subject.worker.processNext()).resolves.toEqual({ kind: "idle" });
    expect(subject.gateway.submit).toHaveBeenCalledTimes(3);
    expect(subject.state.audits.at(-1)?.action).toBe("ANCHOR_JOB_RETRY_EXHAUSTED");
  });

  it("PB3: 3 respuestas RPC inciertas paran en revisión manual sin reenviar", async () => {
    const subject = await fixture();
    subject.gateway.reconcile.mockResolvedValue({ kind: "unknown", code: "RPC_UNAVAILABLE" });
    for (let i = 0; i < 3; i++) {
      subject.setCurrentTime(new Date(startedAt.getTime() + i * 31_000));
      await expect(subject.worker.processNext()).resolves.toMatchObject({
        kind: i === 2 ? "review_required" : "uncertain",
      });
    }
    expect(subject.state.job).toMatchObject({ state: "REVIEW_REQUIRED", nextAttemptAt: null,
      automaticFailureCount: 3 });
    expect(subject.state.alert).toMatchObject({ lifecycleState: "SIGNED_PENDING_ANCHOR",
      anchorStatus: "REVIEW_REQUIRED", publishedAt: null });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    subject.setCurrentTime(new Date(startedAt.getTime() + 200_000));
    await expect(subject.worker.processNext()).resolves.toEqual({ kind: "idle" });
    expect(subject.state.audits.at(-1)?.action).toBe("ANCHOR_JOB_REVIEW_REQUIRED");
  });

  it("PB3: las consultas pendientes SUBMITTED no consumen el presupuesto de fallos", async () => {
    const subject = await fixture({ jobState: "SUBMITTED", alertStatus: "SUBMITTED", existingTxHash: txHash });
    subject.gateway.reconcile.mockImplementation(async (request) => ({
      kind: "submitted",
      receipt: { deploymentId: request.deployment.id, contractId: request.deployment.contractId,
        messageKey: new Uint8Array(request.messageKey), txHash, transactionStatus: "PENDING" },
    }));
    for (let i = 0; i < 5; i++) {
      subject.setCurrentTime(new Date(startedAt.getTime() + i * policy.pollDelayMs));
      await expect(subject.worker.processNext()).resolves.toMatchObject({ kind: "submitted" });
    }
    expect(subject.state.job).toMatchObject({ state: "SUBMITTED", automaticFailureCount: 0,
      attemptCount: 5 });
    expect(subject.gateway.submit).not.toHaveBeenCalled();
    expect(subject.state.alert.lifecycleState).toBe("SIGNED_PENDING_ANCHOR");
  });
});
