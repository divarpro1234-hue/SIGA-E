import { createHash } from "node:crypto";
import {
  Account, Keypair, StrKey, Transaction, TransactionBuilder, rpc, xdr,
} from "@stellar/stellar-sdk";
import type { AnchorDeploymentConfig } from "./soroban-anchor-gateway.js";
import type { SorobanAdminTransactionSubmitter } from "./soroban-testnet-anchor-gateway.js";
import { buildRegisterAlertInvocation } from "./stellar-sdk-soroban-rpc-client.js";
import { sanitizeSorobanSendError, type SorobanSendDiagnostic } from "./soroban-send-diagnostic.js";
import {
  matchesTrustedTestnetDeployment, normalizeTrustedTestnetRpcUrl, TRUSTED_TESTNET,
} from "./trusted-testnet-deployment.js";

export const MANUAL_TESTNET_DEFAULT_MAX_FEE_STROOPS = 40_000n;
export const MANUAL_TESTNET_MAX_FEE_STROOPS = 3_000_000n;
export const DEFAULT_MAX_FEE_STROOPS = 2_000n;

export interface SorobanTransactionSigner {
  readonly publicAddress: string;
  /** Return a signed transaction envelope; the provider owns all secret material. */
  signPreparedXdr(input: {
    readonly transactionXdr: string;
    readonly networkPassphrase: string;
    readonly transactionHash: string;
    readonly authorization?: StellarSigningAuthorization;
    readonly signal?: AbortSignal;
  }): Promise<string>;
}

export interface StellarSigningAuthorization {
  readonly approved: true;
  readonly purpose: "register_alert";
  readonly transactionHash: string;
  readonly expiresAtMs: number;
}

export interface SorobanSubmitRpc {
  getNetwork(): Promise<{ readonly passphrase: string }>;
  getContractWasmByContractId(contractId: string): Promise<Uint8Array>;
  getAccount(address: string): Promise<Account>;
  simulateTransaction(transaction: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(transaction: Transaction): Promise<rpc.Api.SendTransactionResponse>;
}

export type SorobanPreparationRpc = Pick<SorobanSubmitRpc,
  "getNetwork" | "getContractWasmByContractId" | "getAccount" | "simulateTransaction">;
export type SorobanPreparationPhase = "NETWORK" | "WASM" | "ACCOUNT" | "SIMULATION" | "XDR_PREPARATION";

export interface AdminSubmitterConfig {
  readonly deployment: AnchorDeploymentConfig;
  readonly endpointUrl: string;
  readonly submissionEnabled?: boolean;
  readonly timeoutMs: number;
  readonly wasmReadTimeoutMs?: number;
  readonly wasmReadRetries?: 0 | 1;
  readonly shouldRetryWasmRead?: () => boolean;
  readonly onWasmReadAttempt?: (attempt: number, durationMs: number, code: string | null) => void;
  readonly transactionTimeoutSeconds: number;
  /** The only new validity window is the pinned manual Testnet composition. */
  readonly manualTimeboundWindow?: true;
  readonly baseFeeStroops: number;
  readonly maxFeeStroops: bigint;
  /** Only the pinned manual Testnet runner may opt into a ceiling up to 3,000,000 stroops. */
  readonly feeScope?: "trusted-manual-testnet";
  /** The manual CLI signer owns its bounded TTY and process deadlines. */
  readonly signerTimeoutMode?: "self-managed";
  readonly maxInstructions: number;
  readonly maxDiskReadBytes: number;
  readonly maxWriteBytes: number;
  readonly onFeeDiagnostic?: (diagnostic: SorobanFeeDiagnostic) => void;
  readonly authorizeSigning?: (intent: {
    readonly transactionHash: string;
    readonly transactionXdr: string;
    readonly contractId: string;
    readonly messageKey: Uint8Array;
    readonly jwsHash: Uint8Array;
  }) => Promise<StellarSigningAuthorization | null>;
  readonly onPhase?: (phase: SorobanPreparationPhase | "AUTHORIZATION" | "SIGNING" | "SEND") => void;
}

export interface SorobanFeeDiagnostic {
  readonly baseFeeStroops: string;
  readonly minResourceFeeStroops: string | null;
  readonly calculatedTotalFeeStroops: string | null;
  readonly assembledFeeStroops: string | null;
  readonly maxFeeStroops: string;
  readonly rule: "INVALID_MIN_RESOURCE_FEE" | "CALCULATED_TOTAL_EXCEEDS_MAX" |
    "ASSEMBLED_FEE_MISMATCH" | "WITHIN_LIMIT";
}

export type SubmitterErrorCode =
  | "SUBMISSION_DISABLED" | "SIGNER_UNAVAILABLE" | "REQUEST_REJECTED"
  | "PREFLIGHT_REJECTED" | "SIMULATION_FAILED" | "SIMULATION_RPC_FAILED"
  | "SIMULATION_RESPONSE_INVALID" | "SIMULATION_RESTORE_REQUIRED"
  | "SIMULATION_RESULT_INVALID" | "SIMULATION_AUTH_COUNT_INVALID" | "SIMULATION_AUTH_INVALID"
  | "SIMULATION_AUTH_CREDENTIALS_UNSUPPORTED" | "SIMULATION_AUTH_SCOPE_INVALID"
  | "SIMULATION_AUTH_ASSEMBLY_CHANGED"
  | "SIMULATION_FEE_INVALID" | "SIMULATION_FEE_LIMIT_EXCEEDED"
  | "SIMULATION_ASSEMBLED_FEE_MISMATCH"
  | "SIMULATION_ASSEMBLY_FAILED" | "SIGNATURE_REJECTED" | "SIGNER_TIMEOUT" | "RPC_REJECTED"
  | "AUTHORIZATION_DENIED" | "ANCHOR_LEASE_EXPIRED"
  | "TRANSACTION_TIMEBOUNDS_EXPIRED"
  | "TRANSACTION_TIME_MARGIN_INSUFFICIENT"
  | "RPC_TIMEOUT" | "RPC_UNAVAILABLE" | "SEND_RESULT_UNCERTAIN";

export class SorobanSubmitterError extends Error {
  constructor(readonly code: SubmitterErrorCode, readonly sendDiagnostic?: SorobanSendDiagnostic) {
    super(code);
  }
}

function reject(code: SubmitterErrorCode): never {
  throw new SorobanSubmitterError(code);
}

function validBound(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= 0xffff_ffff;
}

function validFeePolicy(config: AdminSubmitterConfig): boolean {
  if (typeof config.maxFeeStroops !== "bigint" ||
      config.maxFeeStroops < BigInt(config.baseFeeStroops) ||
      config.maxFeeStroops > 0xffff_ffffn) return false;
  if (config.feeScope === undefined) return config.maxFeeStroops <= DEFAULT_MAX_FEE_STROOPS;
  return config.feeScope === "trusted-manual-testnet" &&
    config.maxFeeStroops <= MANUAL_TESTNET_MAX_FEE_STROOPS &&
    matchesTrustedTestnetDeployment(config.deployment) &&
    config.endpointUrl === TRUSTED_TESTNET.endpointUrl;
}

function validWasmReadPolicy(config: AdminSubmitterConfig): boolean {
  const isConfigured = config.wasmReadTimeoutMs !== undefined ||
    config.wasmReadRetries !== undefined || config.shouldRetryWasmRead !== undefined ||
    config.onWasmReadAttempt !== undefined;
  if (!isConfigured) return true;
  return config.feeScope === "trusted-manual-testnet" &&
    matchesTrustedTestnetDeployment(config.deployment) &&
    config.endpointUrl === TRUSTED_TESTNET.endpointUrl &&
    (config.wasmReadTimeoutMs === undefined ||
      (Number.isSafeInteger(config.wasmReadTimeoutMs) &&
        config.wasmReadTimeoutMs > 0 && config.wasmReadTimeoutMs <= 20_000)) &&
    (config.wasmReadRetries === undefined ||
      config.wasmReadRetries === 0 || config.wasmReadRetries === 1) &&
    (config.wasmReadRetries !== 1 || config.wasmReadTimeoutMs !== undefined);
}

function validTimeboundPolicy(config: AdminSubmitterConfig): boolean {
  if (!Number.isSafeInteger(config.transactionTimeoutSeconds) ||
      config.transactionTimeoutSeconds < 1 || config.transactionTimeoutSeconds > 300) return false;
  if (config.manualTimeboundWindow === undefined) return true;
  return config.manualTimeboundWindow === true &&
    config.feeScope === "trusted-manual-testnet" &&
    config.transactionTimeoutSeconds === 180 && validFeePolicy(config);
}

function validOperation(tx: Transaction, contractId: string, key?: Uint8Array, hash?: Uint8Array): boolean {
  const op = tx.operations[0];
  if (tx.operations.length !== 1 || op?.type !== "invokeHostFunction" || op.source !== undefined ||
      op.func.type !== "hostFunctionTypeInvokeContract") return false;
  const call = op.func.invokeContract;
  const args = call.args;
  return call.contractAddress.type === "scAddressTypeContract" &&
    Buffer.from(call.contractAddress.contractId.toXdrObject()).equals(Buffer.from(StrKey.decodeContract(contractId))) &&
    call.functionName.toString() === "register_alert" &&
    args.length === 2 && args[0]?.type === "scvBytes" && args[1]?.type === "scvBytes" &&
    args[0].bytes.toXdrObject().length === 32 && args[1].bytes.toXdrObject().length === 32 &&
    (key === undefined || Buffer.from(args[0].bytes.toXdrObject()).equals(Buffer.from(key))) &&
    (hash === undefined || Buffer.from(args[1].bytes.toXdrObject()).equals(Buffer.from(hash)));
}

function expectedAdminAuthorizationInvocation(
  transaction: Transaction,
  contractId: string,
  key: Uint8Array,
  hash: Uint8Array,
): xdr.SorobanAuthorizedInvocation {
  const operation = transaction.operations[0];
  if (operation?.type !== "invokeHostFunction" ||
      operation.func.type !== "hostFunctionTypeInvokeContract") {
    reject("SIMULATION_AUTH_SCOPE_INVALID");
  }
  const call = operation.func.invokeContract;
  const expectedCall = new xdr.InvokeContractArgs({
    contractAddress: call.contractAddress,
    functionName: call.functionName,
    args: call.args,
  });
  const expected = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(expectedCall),
    subInvocations: [],
  });
  if (!validOperation(transaction, contractId, key, hash)) reject("SIMULATION_AUTH_SCOPE_INVALID");
  return expected;
}

function validateAdminSourceAuthorization(
  entries: readonly unknown[],
  expectedInvocation: xdr.SorobanAuthorizedInvocation,
): readonly xdr.SorobanAuthorizationEntry[] {
  if (entries.length !== 1) reject("SIMULATION_AUTH_COUNT_INVALID");
  const entry = entries[0];
  if (!(entry instanceof xdr.SorobanAuthorizationEntry) ||
      !(entry.rootInvocation instanceof xdr.SorobanAuthorizedInvocation)) {
    reject("SIMULATION_AUTH_INVALID");
  }
  // SOURCE_ACCOUNT is bound to the transaction source; its envelope signature authorizes it.
  // ADDRESS variants carry a separate Soroban auth signature and are not covered by that envelope.
  if (entry.credentials.type !== "sorobanCredentialsSourceAccount") {
    reject("SIMULATION_AUTH_CREDENTIALS_UNSUPPORTED");
  }
  if (!Buffer.from(entry.rootInvocation.toXdr()).equals(Buffer.from(expectedInvocation.toXdr()))) {
    reject("SIMULATION_AUTH_SCOPE_INVALID");
  }
  return [entry];
}

function operationAuthorizations(transaction: Transaction): readonly unknown[] {
  const operation = transaction.operations[0];
  if (operation?.type !== "invokeHostFunction" || !Array.isArray(operation.auth)) {
    reject("SIMULATION_AUTH_INVALID");
  }
  return operation.auth;
}

function assertSameAuthorizations(
  expected: readonly xdr.SorobanAuthorizationEntry[],
  actual: readonly unknown[],
): void {
  if (actual.length !== expected.length) reject("SIMULATION_AUTH_ASSEMBLY_CHANGED");
  for (let index = 0; index < expected.length; index += 1) {
    const entry = actual[index];
    if (!(entry instanceof xdr.SorobanAuthorizationEntry) ||
        !Buffer.from(entry.toXdr()).equals(Buffer.from(expected[index]!.toXdr()))) {
      reject("SIMULATION_AUTH_ASSEMBLY_CHANGED");
    }
  }
}

/** Shared validation used by the submitter and the Stellar CLI signer. */
export function inspectPreparedAdminRegisterAlertXdr(input: {
  readonly transactionXdr: string;
  readonly transactionHash: string;
  readonly networkPassphrase: string;
  readonly maxFeeStroops: bigint;
}): Transaction {
  if (input.networkPassphrase !== TRUSTED_TESTNET.networkPassphrase ||
      typeof input.transactionXdr !== "string" || input.transactionXdr.length > 100_000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(input.transactionXdr) ||
      typeof input.transactionHash !== "string" || !/^[0-9a-f]{64}$/u.test(input.transactionHash) ||
      typeof input.maxFeeStroops !== "bigint" || input.maxFeeStroops < 1n) {
    throw new SorobanSubmitterError("SIGNATURE_REJECTED");
  }
  try {
    const prepared = new Transaction(input.transactionXdr, TRUSTED_TESTNET.networkPassphrase);
    if (prepared.toXdr() !== input.transactionXdr ||
        prepared.source !== TRUSTED_TESTNET.adminPublicAddress ||
        prepared.networkPassphrase !== TRUSTED_TESTNET.networkPassphrase ||
        prepared.signatures.length !== 0 ||
        !validOperation(prepared, TRUSTED_TESTNET.contractId) ||
        !/^[1-9][0-9]*$/u.test(prepared.fee) || BigInt(prepared.fee) > input.maxFeeStroops ||
        Buffer.from(prepared.hash()).toString("hex") !== input.transactionHash) {
      throw new Error();
    }
    return prepared;
  } catch {
    throw new SorobanSubmitterError("SIGNATURE_REJECTED");
  }
}

/** Pure verifier also exercised with ephemeral in-memory Ed25519 accounts. */
export function verifySignedEnvelope(prepared: Transaction, signedXdr: string,
  expectedPublicAddress: string, networkPassphrase: string): Transaction {
  try {
    if (typeof signedXdr !== "string" || signedXdr.length > 100_000) throw new Error();
    const signed = new Transaction(signedXdr, networkPassphrase);
    const signature = signed.signatures[0];
    const admin = Keypair.fromPublicKey(expectedPublicAddress);
    if (signed.toXdr() !== signedXdr ||
        prepared.networkPassphrase !== networkPassphrase ||
        prepared.source !== expectedPublicAddress ||
        signed.networkPassphrase !== networkPassphrase ||
        signed.source !== expectedPublicAddress ||
        !Buffer.from(signed.signatureBase()).equals(Buffer.from(prepared.signatureBase())) ||
        signed.signatures.length !== 1 || !signature ||
        !Buffer.from(signature.hint.toXdrObject()).equals(Buffer.from(admin.signatureHint())) ||
        !admin.verify(prepared.hash(), signature.signature.toXdrObject())) throw new Error();
    return signed;
  } catch {
    throw new SorobanSubmitterError("SIGNATURE_REJECTED");
  }
}

/** Checks both unchanged transaction body and the pinned administrator signature. */
export function verifySignedAdminXdr(prepared: Transaction, signedXdr: string): Transaction {
  return verifySignedEnvelope(prepared, signedXdr,
    TRUSTED_TESTNET.adminPublicAddress, TRUSTED_TESTNET.networkPassphrase);
}

export function assertTransactionTimeboundsCurrent(transaction: Transaction, nowMs = Date.now(),
  minimumRemainingSeconds = 0): void {
  const bounds = transaction.timeBounds;
  const now = BigInt(nowMs);
  if (!bounds || !/^[0-9]+$/u.test(bounds.minTime) || !/^[0-9]+$/u.test(bounds.maxTime) ||
      BigInt(bounds.minTime) * 1_000n > now || BigInt(bounds.maxTime) * 1_000n <= now) {
    reject("TRANSACTION_TIMEBOUNDS_EXPIRED");
  }
  if (BigInt(bounds.maxTime) * 1_000n - now < BigInt(minimumRemainingSeconds) * 1_000n) {
    reject("TRANSACTION_TIME_MARGIN_INSUFFICIENT");
  }
}

/** Shared read/simulation path. Its RPC capability deliberately has no send method. */
export async function prepareAdminRegisterAlert(input: {
  readonly config: AdminSubmitterConfig;
  readonly rpcTransport: SorobanPreparationRpc;
  readonly contractId: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly signal: AbortSignal;
  readonly read: <T>(operation: () => Promise<T>, signal: AbortSignal) => Promise<T>;
  readonly readWasm?: (
    operation: () => Promise<Uint8Array>,
    signal: AbortSignal,
  ) => Promise<Uint8Array>;
  readonly onPhase?: (phase: SorobanPreparationPhase) => void;
  readonly onFeeDiagnostic?: (diagnostic: SorobanFeeDiagnostic) => void;
}): Promise<Transaction> {
  const { config, rpcTransport, contractId, messageKey: key, jwsHash: hash, signal, read } = input;
  if (!validBound(config.baseFeeStroops) || !validFeePolicy(config) ||
      !validWasmReadPolicy(config) || !validTimeboundPolicy(config) ||
      contractId !== TRUSTED_TESTNET.contractId) reject("PREFLIGHT_REJECTED");
  input.onPhase?.("NETWORK");
  const network = await read(() => rpcTransport.getNetwork(), signal);
  if (network?.passphrase !== TRUSTED_TESTNET.networkPassphrase) reject("PREFLIGHT_REJECTED");
  input.onPhase?.("WASM");
  const maxWasmAttempts = 1 + (config.wasmReadRetries ?? 0);
  let wasm: Uint8Array | undefined;
  for (let attempt = 1; attempt <= maxWasmAttempts; attempt += 1) {
    const startedAt = Date.now();
    try {
      const observed = input.readWasm
        ? await input.readWasm(() => rpcTransport.getContractWasmByContractId(contractId), signal)
        : await read(() => rpcTransport.getContractWasmByContractId(contractId), signal);
      if (!(observed instanceof Uint8Array) || observed.length === 0) {
        throw new Error("WASM_RESPONSE_INVALID");
      }
      if (createHash("sha256").update(observed).digest("hex") !== TRUSTED_TESTNET.wasmHash) {
        throw new Error("WASM_IDENTITY_MISMATCH");
      }
      wasm = observed;
      config.onWasmReadAttempt?.(attempt, Date.now() - startedAt, null);
      break;
    } catch (error) {
      const timedOut = error instanceof SorobanSubmitterError && error.code === "RPC_TIMEOUT";
      const code = error instanceof Error && error.message === "WASM_IDENTITY_MISMATCH"
        ? "WASM_IDENTITY_MISMATCH"
        : error instanceof Error && error.message === "WASM_RESPONSE_INVALID"
          ? "WASM_RESPONSE_INVALID" : timedOut ? "WASM_RPC_TIMEOUT" : "WASM_QUERY_FAILED";
      config.onWasmReadAttempt?.(attempt, Date.now() - startedAt, code);
      if (error instanceof Error &&
          ["WASM_IDENTITY_MISMATCH", "WASM_RESPONSE_INVALID"].includes(error.message)) {
        reject("PREFLIGHT_REJECTED");
      }
      if (!timedOut || attempt === maxWasmAttempts ||
          (config.shouldRetryWasmRead && !config.shouldRetryWasmRead())) {
        throw error;
      }
    }
  }
  if (!wasm) reject("PREFLIGHT_REJECTED");
  input.onPhase?.("ACCOUNT");
  const source = await read(() => rpcTransport.getAccount(TRUSTED_TESTNET.adminPublicAddress), signal);
  if (!(source instanceof Account) || source.accountId() !== TRUSTED_TESTNET.adminPublicAddress) reject("PREFLIGHT_REJECTED");

  input.onPhase?.("XDR_PREPARATION");
  const raw = new TransactionBuilder(source, {
    fee: String(config.baseFeeStroops),
    networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  }).addOperation(buildRegisterAlertInvocation(config.deployment, key, hash))
    .setTimeout(config.transactionTimeoutSeconds).build();
  if (!validOperation(raw, contractId, key, hash)) reject("PREFLIGHT_REJECTED");

  input.onPhase?.("SIMULATION");
  let simulation: rpc.Api.SimulateTransactionResponse;
  try {
    simulation = await read(() => rpcTransport.simulateTransaction(raw), signal);
  } catch (error) {
    if (error instanceof SorobanSubmitterError) throw error;
    reject("SIMULATION_RPC_FAILED");
  }
  const feeDiagnostic = (min: string | null, total: bigint | null,
    assembled: string | null, rule: SorobanFeeDiagnostic["rule"]): void => {
    input.onFeeDiagnostic?.({ baseFeeStroops: String(config.baseFeeStroops),
      minResourceFeeStroops: min, calculatedTotalFeeStroops: total?.toString() ?? null,
      assembledFeeStroops: assembled, maxFeeStroops: config.maxFeeStroops.toString(), rule });
  };
  if (simulation === null || typeof simulation !== "object") reject("SIMULATION_RESPONSE_INVALID");
  if (rpc.Api.isSimulationError(simulation)) reject("SIMULATION_FAILED");
  if (!rpc.Api.isSimulationSuccess(simulation)) reject("SIMULATION_RESPONSE_INVALID");
  if (!simulation.result || typeof simulation.result !== "object" ||
      !Array.isArray(simulation.result.auth) ||
      !(simulation.result.retval instanceof xdr.ScVal)) reject("SIMULATION_RESPONSE_INVALID");
  if (typeof simulation.minResourceFee !== "string") {
    feeDiagnostic(null, null, null, "INVALID_MIN_RESOURCE_FEE");
    reject("SIMULATION_RESPONSE_INVALID");
  }
  if ("restorePreamble" in simulation) reject("SIMULATION_RESTORE_REQUIRED");
  if (simulation.result.retval.type !== "scvVoid") reject("SIMULATION_RESULT_INVALID");
  const expectedInvocation = expectedAdminAuthorizationInvocation(raw, contractId, key, hash);
  const expectedAuthorizations = validateAdminSourceAuthorization(
    simulation.result.auth,
    expectedInvocation,
  );
  if (!/^(0|[1-9][0-9]*)$/u.test(simulation.minResourceFee)) {
    feeDiagnostic(null, null, null, "INVALID_MIN_RESOURCE_FEE");
    reject("SIMULATION_FEE_INVALID");
  }
  const expectedFee = BigInt(simulation.minResourceFee) + BigInt(config.baseFeeStroops);
  if (expectedFee > config.maxFeeStroops) {
    feeDiagnostic(simulation.minResourceFee, expectedFee, null, "CALCULATED_TOTAL_EXCEEDS_MAX");
    reject("SIMULATION_FEE_LIMIT_EXCEEDED");
  }
  input.onPhase?.("XDR_PREPARATION");
  let prepared: Transaction;
  try { prepared = rpc.assembleTransaction(raw, simulation).build(); }
  catch { return reject("SIMULATION_ASSEMBLY_FAILED"); }
  const assembledFee = /^[1-9][0-9]*$/u.test(prepared.fee) ? prepared.fee : null;
  if (assembledFee === null || BigInt(assembledFee) !== expectedFee) {
    feeDiagnostic(simulation.minResourceFee, expectedFee, assembledFee, "ASSEMBLED_FEE_MISMATCH");
    reject("SIMULATION_ASSEMBLED_FEE_MISMATCH");
  }
  feeDiagnostic(simulation.minResourceFee, expectedFee, assembledFee, "WITHIN_LIMIT");
  const preparedAuthorizations = operationAuthorizations(prepared);
  assertSameAuthorizations(expectedAuthorizations, preparedAuthorizations);
  validateAdminSourceAuthorization(preparedAuthorizations, expectedInvocation);
  if (prepared.networkPassphrase !== TRUSTED_TESTNET.networkPassphrase ||
      prepared.source !== TRUSTED_TESTNET.adminPublicAddress || prepared.signatures.length !== 0 ||
      !validOperation(prepared, contractId, key, hash) ||
      !/^[1-9][0-9]*$/u.test(prepared.fee) || BigInt(prepared.fee) > config.maxFeeStroops) {
    reject("PREFLIGHT_REJECTED");
  }
  const envelope = prepared.toEnvelope();
  if (envelope.type !== "envelopeTypeTx" || envelope.value.tx.ext.type !== "sorobanData") reject("PREFLIGHT_REJECTED");
  const data = envelope.value.tx.ext.value;
  if (data.resources.instructions > config.maxInstructions ||
      data.resources.diskReadBytes > config.maxDiskReadBytes ||
      data.resources.writeBytes > config.maxWriteBytes) reject("PREFLIGHT_REJECTED");
  return prepared;
}

export class StellarSdkSorobanAdminSubmitter implements SorobanAdminTransactionSubmitter {
  readonly publicAddress = TRUSTED_TESTNET.adminPublicAddress;
  private readonly config: AdminSubmitterConfig;

  constructor(
    config: AdminSubmitterConfig,
    private readonly rpcTransport: SorobanSubmitRpc,
    private readonly signer?: SorobanTransactionSigner,
  ) {
    if (!matchesTrustedTestnetDeployment(config.deployment) ||
        normalizeTrustedTestnetRpcUrl(config.endpointUrl) !== TRUSTED_TESTNET.endpointUrl ||
        !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 120_000 ||
        !validTimeboundPolicy(config) ||
        !validBound(config.baseFeeStroops) ||
        !validFeePolicy(config) ||
        !validWasmReadPolicy(config) ||
        (config.signerTimeoutMode !== undefined &&
          (config.signerTimeoutMode !== "self-managed" || config.feeScope !== "trusted-manual-testnet")) ||
        !validBound(config.maxInstructions) || !validBound(config.maxDiskReadBytes) ||
        !validBound(config.maxWriteBytes)) {
      throw new TypeError("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    }
    this.config = Object.freeze({ ...config, deployment: Object.freeze({ ...config.deployment }) });
  }

  async registerAlert(input: Parameters<SorobanAdminTransactionSubmitter["registerAlert"]>[0]): Promise<unknown> {
    if (this.config.submissionEnabled !== true) reject("SUBMISSION_DISABLED");
    if (!this.signer || this.signer.publicAddress !== this.publicAddress) reject("SIGNER_UNAVAILABLE");
    if (input.signal.aborted ||
        normalizeTrustedTestnetRpcUrl(input.endpointUrl) !== TRUSTED_TESTNET.endpointUrl ||
        input.networkPassphrase !== TRUSTED_TESTNET.networkPassphrase ||
        input.contractId !== TRUSTED_TESTNET.contractId ||
        !(input.messageKey instanceof Uint8Array) || input.messageKey.length !== 32 ||
        !(input.jwsHash instanceof Uint8Array) || input.jwsHash.length !== 32 ||
        (input.leaseExpiresAt !== undefined &&
          (!(input.leaseExpiresAt instanceof Date) ||
            !Number.isFinite(input.leaseExpiresAt.getTime())))) {
      reject("REQUEST_REJECTED");
    }
    const assertLeaseCurrent = () => {
      if (input.leaseExpiresAt && input.leaseExpiresAt.getTime() <= Date.now()) {
        reject("ANCHOR_LEASE_EXPIRED");
      }
    };
    assertLeaseCurrent();
    const key = Uint8Array.from(input.messageKey);
    const hash = Uint8Array.from(input.jwsHash);
    const prepared = await prepareAdminRegisterAlert({
      config: this.config, rpcTransport: this.rpcTransport, contractId: input.contractId,
      messageKey: key, jwsHash: hash, signal: input.signal,
      read: (operation, signal) => this.read(operation, signal),
      ...(this.config.wasmReadTimeoutMs !== undefined ? {
        readWasm: (operation: () => Promise<Uint8Array>, signal: AbortSignal) =>
          this.readWithTimeout(
            operation, signal, this.config.wasmReadTimeoutMs ?? this.config.timeoutMs,
          ),
      } : {}),
      onPhase: (phase) => this.config.onPhase?.(phase),
      onFeeDiagnostic: (diagnostic) => this.config.onFeeDiagnostic?.(diagnostic),
    });

    let signedXdr: string;
    try {
      assertLeaseCurrent();
      this.config.onPhase?.("AUTHORIZATION");
      const transactionHash = Buffer.from(prepared.hash()).toString("hex");
      const authorization = this.config.authorizeSigning
        ? await this.config.authorizeSigning({
          transactionHash, transactionXdr: prepared.toXdr(),
          contractId: TRUSTED_TESTNET.contractId,
          messageKey: Uint8Array.from(key), jwsHash: Uint8Array.from(hash),
        })
        : null;
      assertLeaseCurrent();
      if (this.config.authorizeSigning && (!authorization || authorization.approved !== true ||
          authorization.purpose !== "register_alert" ||
          authorization.transactionHash !== transactionHash ||
          !Number.isSafeInteger(authorization.expiresAtMs) ||
          authorization.expiresAtMs <= Date.now() || authorization.expiresAtMs > Date.now() + 60_000)) {
        reject("AUTHORIZATION_DENIED");
      }
      this.config.onPhase?.("XDR_PREPARATION");
      assertTransactionTimeboundsCurrent(prepared, Date.now(), this.config.manualTimeboundWindow ? 20 : 0);
      this.config.onPhase?.("SIGNING");
      const sign = () => this.signer!.signPreparedXdr({
        transactionXdr: prepared.toXdr(),
        networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
        transactionHash,
        ...(authorization ? { authorization } : {}),
        signal: input.signal,
      });
      signedXdr = this.config.signerTimeoutMode === "self-managed"
        ? await sign() : await this.withDeadline(sign, input.signal);
      assertLeaseCurrent();
    } catch (error) {
      if (error instanceof SorobanSubmitterError && ["AUTHORIZATION_DENIED",
        "ANCHOR_LEASE_EXPIRED", "TRANSACTION_TIMEBOUNDS_EXPIRED",
        "TRANSACTION_TIME_MARGIN_INSUFFICIENT"].includes(error.code)) throw error;
      if (error instanceof SorobanSubmitterError && error.code === "RPC_TIMEOUT") {
        return reject("SIGNER_TIMEOUT");
      }
      return reject("SIGNATURE_REJECTED");
    }
    this.config.onPhase?.("SIGNING");
    const signed = verifySignedAdminXdr(prepared, signedXdr);
    this.config.onPhase?.("XDR_PREPARATION");
    assertTransactionTimeboundsCurrent(signed, Date.now(), this.config.manualTimeboundWindow ? 20 : 0);
    if (input.signal.aborted) reject("RPC_TIMEOUT");
    assertLeaseCurrent();

    let response: rpc.Api.SendTransactionResponse;
    try {
      this.config.onPhase?.("SEND");
      response = await this.withDeadline(() => this.rpcTransport.sendTransaction(signed), input.signal);
    } catch {
      return reject("SEND_RESULT_UNCERTAIN");
    }
    const expectedTxHash = Buffer.from(prepared.hash()).toString("hex");
    const responseHash = typeof response?.hash === "string" ? response.hash.toLowerCase() : null;
    if (response?.status === "ERROR" && responseHash === expectedTxHash) {
      throw new SorobanSubmitterError("RPC_REJECTED", sanitizeSorobanSendError(response));
    }
    if (response?.status !== "PENDING" || responseHash !== expectedTxHash) {
      reject("SEND_RESULT_UNCERTAIN");
    }
    return { status: "PENDING", hash: expectedTxHash };
  }

  private async read<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    return this.readWithTimeout(operation, signal, this.config.timeoutMs);
  }

  private async readWithTimeout<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<T> {
    try { return await this.withDeadline(operation, signal, timeoutMs); }
    catch (error) {
      if (error instanceof SorobanSubmitterError) throw error;
      const sdkTimedOut = error instanceof Error &&
        (error.name === "TimeoutError" || /^timeout of \d+ms exceeded$/u.test(error.message));
      return reject(signal.aborted || sdkTimedOut ? "RPC_TIMEOUT" : "RPC_UNAVAILABLE");
    }
  }

  private async withDeadline<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
    timeoutMs = this.config.timeoutMs,
  ): Promise<T> {
    if (signal.aborted) reject("RPC_TIMEOUT");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        operation(),
        new Promise<never>((_resolve, rejectPromise) => {
          timer = setTimeout(() => rejectPromise(new SorobanSubmitterError("RPC_TIMEOUT")), timeoutMs);
          onAbort = () => rejectPromise(new SorobanSubmitterError("RPC_TIMEOUT"));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }
}
