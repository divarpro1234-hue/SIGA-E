import { createHash } from "node:crypto";
import type {
  AnchorConfirmation,
  AnchorDeploymentConfig,
  AnchorReconciliation,
  AnchorRequest,
  AnchorSubmission,
  SorobanAnchorGateway,
} from "./soroban-anchor-gateway.js";
import { SorobanSubmitterError } from "./stellar-sdk-admin-submitter.js";
import {
  createAnchorConfirmation,
  decodeAnchorContractRead,
  decodeAnchorTransaction,
  equalAnchorBytes,
  type AnchorTransactionResult,
} from "./anchor-reconciliation-evidence.js";

export class SorobanGatewaySubmissionError extends Error {
  constructor(readonly phase: "PREFLIGHT" | "SUBMITTER", readonly code: string) {
    super(phase === "PREFLIGHT" ? "SOROBAN_SUBMISSION_PREFLIGHT_FAILED" : "SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
  }
}

function safeSubmissionCause(error: unknown): string {
  if (error instanceof SorobanSubmitterError) return error.code;
  if (error instanceof Error && [
    "SOROBAN_RPC_TIMEOUT", "STELLAR_RPC_TIMEOUT",
    "ANCHOR_LEASE_EXPIRED",
    "WASM_RPC_TIMEOUT",
    "SOROBAN_NETWORK_IDENTITY_MISMATCH", "SOROBAN_WASM_IDENTITY_MISMATCH",
    "SOROBAN_WASM_RESPONSE_INVALID",
    "STELLAR_RPC_NETWORK_QUERY_FAILED", "STELLAR_RPC_CONTRACT_READ_FAILED",
    "STELLAR_RPC_WASM_QUERY_FAILED", "STELLAR_RPC_ABORTED",
  ].includes(error.message)) return error.message;
  return "UNCLASSIFIED_ERROR";
}

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/u;
const PUBLIC_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/u;
const HASH_PATTERN = /^[A-Fa-f0-9]{64}$/u;
const TRUSTED_TESTNET_RPC_HOST = "soroban-testnet.stellar.org";
// get_alert loads the source account and then simulates the contract call.
const CONTRACT_READ_RPC_OPERATION_COUNT = 2;

export interface SorobanTestnetRpcClient {
  getNetwork(input: {
    readonly endpointUrl: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  getContractWasm?(input: {
    readonly endpointUrl: string;
    readonly contractId: string;
    readonly signal: AbortSignal;
  }): Promise<Uint8Array>;
  getTransaction(input: {
    readonly endpointUrl: string;
    readonly transactionHash: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  getAlert(input: {
    readonly endpointUrl: string;
    readonly networkPassphrase: string;
    readonly contractId: string;
    readonly messageKey: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface SorobanContractReadResult {
  readonly contractId: string;
  readonly method: "get_alert";
  readonly messageKey: Uint8Array;
  readonly value: unknown;
}

export interface SorobanAdminTransactionSubmitter {
  readonly publicAddress: string;
  registerAlert(input: {
    readonly endpointUrl: string;
    readonly networkPassphrase: string;
    readonly contractId: string;
    readonly messageKey: Uint8Array;
    readonly jwsHash: Uint8Array;
    readonly leaseExpiresAt?: Date;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface SorobanTestnetGatewayConfig {
  readonly enabled?: boolean;
  readonly submissionEnabled?: boolean;
  readonly endpointUrl: string;
  readonly deployment: AnchorDeploymentConfig;
  readonly timeoutMs: number;
  readonly wasmReadRetries?: 0 | 1;
  readonly shouldRetryWasmRead?: () => boolean;
  readonly onWasmReadAttempt?: (attempt: number, durationMs: number, code: string | null) => void;
  /** Manual interactive submitter enforces its own per-RPC, signing and prompt deadlines. */
  readonly submitterTimeoutMode?: "self-managed";
  readonly leaseAwareSubmitter?: true;
  readonly onPhase?: (phase: "NETWORK" | "WASM" | "CONTRACT_READ" | "RECONCILIATION" | "SUBMITTER") => void;
  readonly onTimeout?: (phase: "NETWORK" | "WASM" | "CONTRACT_READ" | "RECONCILIATION") => void;
}

function validDeployment(deployment: AnchorDeploymentConfig): boolean {
  return deployment.network === "TESTNET" &&
    deployment.networkPassphrase === TESTNET_PASSPHRASE &&
    typeof deployment.id === "string" && deployment.id.length > 0 &&
    CONTRACT_ID_PATTERN.test(deployment.contractId) &&
    HASH_PATTERN.test(deployment.wasmHash) &&
    PUBLIC_ADDRESS_PATTERN.test(deployment.adminPublicAddress) &&
    Number.isSafeInteger(deployment.generation) && deployment.generation > 0 &&
    typeof deployment.trustedConfigVersion === "string" &&
    deployment.trustedConfigVersion.length > 0;
}

function validateConfig(config: SorobanTestnetGatewayConfig): void {
  if (config.enabled !== true || !validDeployment(config.deployment) ||
      !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 ||
      config.timeoutMs > 120_000 ||
      (config.wasmReadRetries !== undefined && config.wasmReadRetries !== 0 && config.wasmReadRetries !== 1)) {
    throw new TypeError("SOROBAN_TESTNET_GATEWAY_CONFIGURATION_INVALID");
  }
  let endpoint: URL;
  try {
    endpoint = new URL(config.endpointUrl);
  } catch {
    throw new TypeError("SOROBAN_TESTNET_GATEWAY_CONFIGURATION_INVALID");
  }
  if (endpoint.protocol !== "https:" || endpoint.hostname !== TRUSTED_TESTNET_RPC_HOST ||
      endpoint.port !== "" || endpoint.pathname !== "/" ||
      endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.search !== "" || endpoint.hash !== "") {
    throw new TypeError("SOROBAN_TESTNET_GATEWAY_CONFIGURATION_INVALID");
  }
}

function sameDeployment(
  expected: AnchorDeploymentConfig,
  actual: AnchorDeploymentConfig,
): boolean {
  return actual.network === expected.network &&
    actual.networkPassphrase === expected.networkPassphrase &&
    actual.id === expected.id &&
    actual.contractId === expected.contractId &&
    actual.wasmHash === expected.wasmHash &&
    actual.adminPublicAddress === expected.adminPublicAddress &&
    actual.generation === expected.generation &&
    actual.trustedConfigVersion === expected.trustedConfigVersion;
}

function validRequest(request: AnchorRequest, deployment: AnchorDeploymentConfig): boolean {
  return sameDeployment(deployment, request.deployment) &&
    request.messageKey instanceof Uint8Array && request.messageKey.length === 32 &&
    request.jwsHash instanceof Uint8Array && request.jwsHash.length === 32 &&
    Number.isSafeInteger(request.attemptCount) && request.attemptCount > 0 &&
    request.leaseExpiresAt instanceof Date &&
    Number.isFinite(request.leaseExpiresAt.getTime());
}

function validTransactionHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

export class SorobanTestnetAnchorGateway implements SorobanAnchorGateway {
  readonly trustDomain = "STELLAR_TESTNET" as const;
  private readonly config: SorobanTestnetGatewayConfig;

  constructor(
    config: SorobanTestnetGatewayConfig,
    private readonly rpc: SorobanTestnetRpcClient,
    private readonly submitter?: SorobanAdminTransactionSubmitter,
    private readonly now: () => Date = () => new Date(),
  ) {
    validateConfig(config);
    this.config = Object.freeze({
      ...config,
      deployment: Object.freeze({ ...config.deployment }),
    });
  }

  async reconcile(
    request: AnchorRequest,
    priorTxHash: string | null,
  ): Promise<AnchorReconciliation> {
    if (!validRequest(request, this.config.deployment) ||
        (priorTxHash !== null && !validTransactionHash(priorTxHash))) {
      return { kind: "unknown", code: "RESULT_UNCERTAIN" };
    }

    try {
      this.config.onPhase?.("NETWORK");
      await this.assertTestnet();
      if (priorTxHash !== null) this.config.onPhase?.("RECONCILIATION");
      const transaction = priorTxHash === null ? null : await this.readTransaction(priorTxHash);
      if (transaction?.status === "INVALID") {
        return { kind: "unknown", code: "RESULT_UNCERTAIN" };
      }
      this.config.onPhase?.("CONTRACT_READ");
      const storedHash = await this.readContractHash(request, CONTRACT_READ_RPC_OPERATION_COUNT);
      if (storedHash === undefined) return { kind: "unknown", code: "RESULT_UNCERTAIN" };
      if (storedHash !== null) {
        if (!equalAnchorBytes(storedHash, request.jwsHash)) {
          return {
            kind: "conflict",
            deploymentId: request.deployment.id,
            contractId: request.deployment.contractId,
            messageKey: Uint8Array.from(request.messageKey),
            observedContractHash: storedHash,
          };
        }
        const evidence = this.confirmation(request, priorTxHash, transaction, storedHash);
        if (evidence === null) {
          return {
            kind: "matching_read",
            deploymentId: request.deployment.id,
            contractId: request.deployment.contractId,
            messageKey: Uint8Array.from(request.messageKey),
            observedContractHash: storedHash,
          };
        }
        return { kind: "confirmed", evidence };
      }

      if (priorTxHash === null) {
        return {
          kind: "absent",
          deploymentId: request.deployment.id,
          contractId: request.deployment.contractId,
          messageKey: Uint8Array.from(request.messageKey),
          observedContractHash: null,
          priorTransactionStatus: "NOT_APPLICABLE",
        };
      }
      if (transaction?.status === "FAILED") {
        return {
          kind: "absent",
          deploymentId: request.deployment.id,
          contractId: request.deployment.contractId,
          messageKey: Uint8Array.from(request.messageKey),
          observedContractHash: null,
          priorTransactionStatus: "FAILED",
        };
      }
      return { kind: "unknown", code: "RESULT_UNCERTAIN" };
    } catch {
      return { kind: "unknown", code: "RPC_UNAVAILABLE" };
    }
  }

  async submit(request: AnchorRequest): Promise<AnchorSubmission> {
    if (!validRequest(request, this.config.deployment)) {
      throw new Error("SOROBAN_REQUEST_INVALID");
    }
    if (this.config.submissionEnabled !== true || !this.submitter) {
      throw new Error("SOROBAN_SUBMISSION_DISABLED");
    }
    if (this.submitter.publicAddress !== this.config.deployment.adminPublicAddress) {
      throw new Error("SOROBAN_ADMIN_AUTHORITY_MISMATCH");
    }
    if (request.leaseExpiresAt.getTime() <= this.now().getTime()) {
      throw new Error("SOROBAN_LEASE_EXPIRED");
    }

    let storedHash: Uint8Array | null | undefined;
    try {
      this.config.onPhase?.("NETWORK");
      await this.assertTestnet();
      this.config.onPhase?.("CONTRACT_READ");
      storedHash = await this.readContractHash(request, CONTRACT_READ_RPC_OPERATION_COUNT);
    } catch (error) {
      throw new SorobanGatewaySubmissionError("PREFLIGHT", safeSubmissionCause(error));
    }
    if (storedHash !== null) {
      throw new Error("SOROBAN_RECONCILIATION_REQUIRED");
    }
    if (request.leaseExpiresAt.getTime() <= this.now().getTime()) {
      throw new Error("SOROBAN_LEASE_EXPIRED");
    }

    let response: unknown;
    try {
      this.config.onPhase?.("SUBMITTER");
      const register = (signal: AbortSignal) => this.submitter!.registerAlert({
        endpointUrl: this.config.endpointUrl,
        networkPassphrase: this.config.deployment.networkPassphrase,
        contractId: this.config.deployment.contractId,
        messageKey: Uint8Array.from(request.messageKey),
        jwsHash: Uint8Array.from(request.jwsHash),
        ...(this.config.leaseAwareSubmitter
          ? { leaseExpiresAt: request.leaseExpiresAt }
          : {}),
        signal,
      });
      response = this.config.submitterTimeoutMode === "self-managed"
        ? await register(new AbortController().signal)
        : await this.withTimeout(register);
    } catch (error) {
      if (error instanceof SorobanSubmitterError && error.code === "RPC_REJECTED") {
        return { kind: "retryable_failure", code: "RPC_REJECTED",
          ...(error.sendDiagnostic ? { sendDiagnostic: error.sendDiagnostic } : {}) };
      }
      if (error instanceof SorobanSubmitterError && error.code === "SIMULATION_FAILED") {
        return { kind: "retryable_failure", code: "SIMULATION_FAILED" };
      }
      throw new SorobanGatewaySubmissionError("SUBMITTER", safeSubmissionCause(error));
    }
    const receipt = this.decodeSubmission(response);
    return {
      kind: "submitted",
      receipt: {
        deploymentId: request.deployment.id,
        contractId: request.deployment.contractId,
        messageKey: Uint8Array.from(request.messageKey),
        txHash: receipt,
        transactionStatus: "PENDING",
      },
    };
  }

  private async assertTestnet(): Promise<void> {
    const response = await this.withTimeout((signal) => this.rpc.getNetwork({
      endpointUrl: this.config.endpointUrl,
      signal,
    }), "NETWORK");
    if (response === null || typeof response !== "object" || Array.isArray(response) ||
        (response as Record<string, unknown>)["passphrase"] !== TESTNET_PASSPHRASE ||
        TESTNET_PASSPHRASE !== this.config.deployment.networkPassphrase) {
      throw new Error("SOROBAN_NETWORK_IDENTITY_MISMATCH");
    }
    if (this.rpc.getContractWasm) {
      this.config.onPhase?.("WASM");
      const maxAttempts = 1 + (this.config.wasmReadRetries ?? 0);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const startedAt = Date.now();
        try {
          const wasm = await this.withTimeout((signal) => this.rpc.getContractWasm!({
            endpointUrl: this.config.endpointUrl,
            contractId: this.config.deployment.contractId,
            signal,
          }), "WASM");
          if (!(wasm instanceof Uint8Array) || wasm.length === 0) {
            throw new Error("SOROBAN_WASM_RESPONSE_INVALID");
          }
          if (createHash("sha256").update(wasm).digest("hex") !== this.config.deployment.wasmHash) {
            throw new Error("SOROBAN_WASM_IDENTITY_MISMATCH");
          }
          this.config.onWasmReadAttempt?.(attempt, Date.now() - startedAt, null);
          return;
        } catch (error) {
          const timedOut = error instanceof Error &&
            ["SOROBAN_RPC_TIMEOUT", "STELLAR_RPC_TIMEOUT", "WASM_RPC_TIMEOUT"].includes(error.message);
          const code = error instanceof Error &&
            error.message === "SOROBAN_WASM_IDENTITY_MISMATCH" ? "WASM_IDENTITY_MISMATCH"
            : error instanceof Error && error.message === "SOROBAN_WASM_RESPONSE_INVALID"
              ? "WASM_RESPONSE_INVALID" : timedOut ? "WASM_RPC_TIMEOUT" : "WASM_QUERY_FAILED";
          this.config.onWasmReadAttempt?.(attempt, Date.now() - startedAt, code);
          if (!timedOut || attempt === maxAttempts ||
              (this.config.shouldRetryWasmRead && !this.config.shouldRetryWasmRead())) {
            throw error;
          }
        }
      }
    }
  }

  private async readTransaction(hash: string): Promise<AnchorTransactionResult> {
    const response = await this.withTimeout((signal) => this.rpc.getTransaction({
      endpointUrl: this.config.endpointUrl,
      transactionHash: hash,
      signal,
    }), "RECONCILIATION");
    return decodeAnchorTransaction(response, hash);
  }

  private async readContractHash(
    request: AnchorRequest,
    rpcOperationCount = 1,
  ): Promise<Uint8Array | null | undefined> {
    const response = await this.withTimeout((signal) => this.rpc.getAlert({
      endpointUrl: this.config.endpointUrl,
      networkPassphrase: this.config.deployment.networkPassphrase,
      contractId: this.config.deployment.contractId,
      messageKey: Uint8Array.from(request.messageKey),
      signal,
    }), "CONTRACT_READ", this.config.timeoutMs * rpcOperationCount);
    return decodeAnchorContractRead(response, request.deployment, request.messageKey);
  }

  private confirmation(
    request: AnchorRequest,
    priorTxHash: string | null,
    transaction: AnchorTransactionResult | null,
    observedContractHash: Uint8Array,
  ): AnchorConfirmation | null {
    if (priorTxHash === null || transaction === null) return null;
    return createAnchorConfirmation({
      deployment: request.deployment,
      messageKey: request.messageKey,
      jwsHash: request.jwsHash,
      txHash: priorTxHash,
      transaction,
      observedContractHash,
      verifiedAt: this.now(),
    });
  }

  private decodeSubmission(value: unknown): string {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("SOROBAN_SUBMISSION_RESPONSE_INVALID");
    }
    const response = value as Record<string, unknown>;
    if (response["status"] !== "PENDING" || typeof response["hash"] !== "string" ||
        !validTransactionHash(response["hash"])) {
      throw new Error("SOROBAN_SUBMISSION_RESPONSE_INVALID");
    }
    return response["hash"].toLowerCase();
  }

  private async withTimeout<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    phase: "NETWORK" | "WASM" | "CONTRACT_READ" | "RECONCILIATION" | "SUBMITTER" = "SUBMITTER",
    timeoutMs = this.config.timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            if (phase !== "SUBMITTER") this.config.onTimeout?.(phase);
            reject(new Error("SOROBAN_RPC_TIMEOUT"));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}
