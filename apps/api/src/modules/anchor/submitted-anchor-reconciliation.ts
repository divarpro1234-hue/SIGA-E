import { createHash } from "node:crypto";
import type {
  AnchorConfirmation,
  AnchorDeploymentConfig,
} from "./soroban-anchor-gateway.js";
import {
  createAnchorConfirmation,
  decodeAnchorContractRead,
  decodeAnchorTransaction,
} from "./anchor-reconciliation-evidence.js";
import { TRUSTED_TESTNET } from "./trusted-testnet-deployment.js";

export interface ReadOnlySorobanRpcClient {
  getNetwork(input: {
    readonly endpointUrl: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
  getContractWasm(input: {
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

export interface SubmittedAnchorReadRequest {
  readonly deployment: AnchorDeploymentConfig;
  readonly endpointUrl: string;
  readonly timeoutMs: number;
  readonly transactionHash: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
}

export interface SubmittedAnchorReadResults {
  readonly transaction: unknown;
  readonly contractRead: unknown;
}

function fail(code: string): never {
  throw new Error(code);
}

export function confirmSubmittedAnchorReadback(input: {
  readonly deployment: AnchorDeploymentConfig;
  readonly transactionHash: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly results: SubmittedAnchorReadResults;
  readonly verifiedAt: Date;
}): AnchorConfirmation {
  if (input.results.transaction === null || typeof input.results.transaction !== "object" ||
      Array.isArray(input.results.transaction) ||
      Reflect.get(input.results.transaction, "txHash") !== input.transactionHash) {
    fail("ANCHOR_TRANSACTION_RESULT_INVALID");
  }
  const transaction = decodeAnchorTransaction(input.results.transaction, input.transactionHash);
  if (transaction.status === "INVALID") fail("ANCHOR_TRANSACTION_RESULT_INVALID");
  const observedContractHash = decodeAnchorContractRead(
    input.results.contractRead, input.deployment, input.messageKey,
  );
  if (observedContractHash === undefined) fail("ANCHOR_CONTRACT_READ_INVALID");
  if (observedContractHash === null) fail("ANCHOR_CONTRACT_ENTRY_NOT_FOUND");
  if (Buffer.compare(Buffer.from(observedContractHash), Buffer.from(input.jwsHash)) !== 0) {
    fail("ANCHOR_CONTRACT_HASH_MISMATCH");
  }
  if (transaction.status !== "SUCCESS") {
    fail(`ANCHOR_TRANSACTION_${transaction.status}`);
  }
  const evidence = createAnchorConfirmation({
    deployment: input.deployment,
    messageKey: input.messageKey,
    jwsHash: input.jwsHash,
    txHash: input.transactionHash,
    transaction,
    observedContractHash,
    verifiedAt: input.verifiedAt,
  });
  if (!evidence) fail("ANCHOR_CONFIRMATION_INVALID");
  return evidence;
}

export async function reconcileSubmittedAnchorReadOnly(
  input: SubmittedAnchorReadRequest,
  rpc: ReadOnlySorobanRpcClient,
  now: () => Date = () => new Date(),
): Promise<AnchorConfirmation> {
  if (input.deployment.network !== TRUSTED_TESTNET.network ||
      input.deployment.networkPassphrase !== TRUSTED_TESTNET.networkPassphrase ||
      input.deployment.contractId !== TRUSTED_TESTNET.contractId ||
      input.deployment.wasmHash !== TRUSTED_TESTNET.wasmHash ||
      input.deployment.adminPublicAddress !== TRUSTED_TESTNET.adminPublicAddress ||
      input.endpointUrl !== TRUSTED_TESTNET.endpointUrl ||
      !/^[a-fA-F0-9]{64}$/u.test(input.transactionHash) ||
      input.messageKey.length !== 32 || input.jwsHash.length !== 32 ||
      !Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1 ||
      input.timeoutMs > 120_000) {
    fail("ANCHOR_TRUSTED_DEPLOYMENT_UNAVAILABLE");
  }

  const network = await rpc.getNetwork({
    endpointUrl: input.endpointUrl,
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (network === null || typeof network !== "object" ||
      (network as { passphrase?: unknown }).passphrase !== input.deployment.networkPassphrase) {
    fail("SOROBAN_NETWORK_IDENTITY_MISMATCH");
  }
  const wasm = await rpc.getContractWasm({
    endpointUrl: input.endpointUrl,
    contractId: input.deployment.contractId,
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  if (!(wasm instanceof Uint8Array) ||
      createHash("sha256").update(wasm).digest("hex") !== input.deployment.wasmHash) {
    fail("SOROBAN_WASM_IDENTITY_MISMATCH");
  }

  const [transactionValue, contractReadValue] = await Promise.all([
    rpc.getTransaction({
      endpointUrl: input.endpointUrl,
      transactionHash: input.transactionHash,
      signal: AbortSignal.timeout(input.timeoutMs),
    }),
    rpc.getAlert({
      endpointUrl: input.endpointUrl,
      networkPassphrase: input.deployment.networkPassphrase,
      contractId: input.deployment.contractId,
      messageKey: Uint8Array.from(input.messageKey),
      signal: AbortSignal.timeout(input.timeoutMs),
    }),
  ]);
  return confirmSubmittedAnchorReadback({
    deployment: input.deployment,
    transactionHash: input.transactionHash,
    messageKey: input.messageKey,
    jwsHash: input.jwsHash,
    results: { transaction: transactionValue, contractRead: contractReadValue },
    verifiedAt: now(),
  });
}
