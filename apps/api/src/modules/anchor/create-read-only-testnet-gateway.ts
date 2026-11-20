import { createHash } from "node:crypto";
import type { AnchorDeploymentConfig } from "./soroban-anchor-gateway.js";
import { SorobanTestnetAnchorGateway, type SorobanTestnetRpcClient } from "./soroban-testnet-anchor-gateway.js";
import { StellarSdkSorobanRpcClient, type StellarRpcServerFactory } from "./stellar-sdk-soroban-rpc-client.js";
import {
  matchesTrustedTestnetDeployment,
  normalizeTrustedTestnetRpcUrl,
  TRUSTED_TESTNET,
} from "./trusted-testnet-deployment.js";

/** Construction is local; RPC reads occur only when reconcile is called. */
export function createReadOnlyTestnetGateway(input: {
  readonly deployment: AnchorDeploymentConfig;
  readonly endpointUrl: string;
  readonly timeoutMs: number;
  readonly wasmReadRetries?: 0 | 1;
  readonly shouldRetryWasmRead?: () => boolean;
  readonly onWasmReadAttempt?: (attempt: number, durationMs: number, code: string | null) => void;
}, serverFactory?: StellarRpcServerFactory,
onPhase?: (phase: "NETWORK" | "WASM" | "CONTRACT_READ" | "RECONCILIATION") => void,
onFailure?: (code: "NETWORK_QUERY_FAILED" | "NETWORK_IDENTITY_MISMATCH" |
  "NETWORK_RPC_TIMEOUT" | "WASM_QUERY_FAILED" | "WASM_IDENTITY_MISMATCH" |
  "WASM_RPC_TIMEOUT" | "CONTRACT_READ_FAILED" | "CONTRACT_READ_RPC_TIMEOUT") => void,
): SorobanTestnetAnchorGateway {
  if (!matchesTrustedTestnetDeployment(input.deployment)) {
    throw new TypeError("SOROBAN_TRUSTED_DEPLOYMENT_MISMATCH");
  }
  const endpointUrl = normalizeTrustedTestnetRpcUrl(input.endpointUrl);
  const client = new StellarSdkSorobanRpcClient({
    endpointUrl,
    deployment: input.deployment,
    timeoutMs: input.timeoutMs,
  }, serverFactory);

  const failureCode = (
    phase: "NETWORK" | "WASM" | "CONTRACT_READ",
    error: unknown,
  ): "NETWORK_QUERY_FAILED" | "NETWORK_RPC_TIMEOUT" | "WASM_QUERY_FAILED" |
    "WASM_RPC_TIMEOUT" | "CONTRACT_READ_FAILED" | "CONTRACT_READ_RPC_TIMEOUT" | null => {
    if (error instanceof Error && error.message === "STELLAR_RPC_ABORTED") return null;
    if (error instanceof Error && error.message === "STELLAR_RPC_TIMEOUT") {
      if (phase === "NETWORK") return "NETWORK_RPC_TIMEOUT";
      if (phase === "WASM") return "WASM_RPC_TIMEOUT";
      return "CONTRACT_READ_RPC_TIMEOUT";
    }
    return phase === "NETWORK" ? "NETWORK_QUERY_FAILED"
      : phase === "WASM" ? "WASM_QUERY_FAILED" : "CONTRACT_READ_FAILED";
  };

  const verifiedRpc: SorobanTestnetRpcClient = {
    async getNetwork(request) {
      let network: unknown;
      try { network = await client.getNetwork(request); }
      catch (error) {
        const code = failureCode("NETWORK", error);
        if (code) onFailure?.(code);
        throw new Error("SOROBAN_NETWORK_QUERY_FAILED");
      }
      if (network === null || typeof network !== "object" ||
          (network as { passphrase?: unknown }).passphrase !== TRUSTED_TESTNET.networkPassphrase) {
        onFailure?.("NETWORK_IDENTITY_MISMATCH");
        throw new Error("SOROBAN_NETWORK_IDENTITY_MISMATCH");
      }
      return network;
    },
    async getContractWasm(request) {
      let wasm: Uint8Array;
      try {
        wasm = await client.getContractWasm({
          endpointUrl: request.endpointUrl,
          contractId: TRUSTED_TESTNET.contractId,
          signal: request.signal,
        });
      } catch (error) {
        const code = failureCode("WASM", error);
        if (code) onFailure?.(code);
        throw new Error(code ?? "SOROBAN_WASM_QUERY_FAILED");
      }
      if (createHash("sha256").update(wasm).digest("hex") !== TRUSTED_TESTNET.wasmHash) {
        onFailure?.("WASM_IDENTITY_MISMATCH");
        throw new Error("SOROBAN_WASM_IDENTITY_MISMATCH");
      }
      return wasm;
    },
    getTransaction: (request) => client.getTransaction(request),
    getAlert: async (request) => {
      try { return await client.getAlert(request); }
      catch (error) {
        const code = failureCode("CONTRACT_READ", error);
        if (code) onFailure?.(code);
        throw new Error("SOROBAN_CONTRACT_READ_FAILED");
      }
    },
  };

  return new SorobanTestnetAnchorGateway({
    enabled: true,
    submissionEnabled: false,
    endpointUrl,
    deployment: input.deployment,
    timeoutMs: input.timeoutMs,
    ...(input.wasmReadRetries !== undefined ? { wasmReadRetries: input.wasmReadRetries } : {}),
    ...(input.shouldRetryWasmRead ? { shouldRetryWasmRead: input.shouldRetryWasmRead } : {}),
    ...(input.onWasmReadAttempt ? { onWasmReadAttempt: input.onWasmReadAttempt } : {}),
    ...(onPhase ? {
      onPhase: (phase: "NETWORK" | "WASM" | "CONTRACT_READ" | "RECONCILIATION" | "SUBMITTER") => {
        if (phase !== "SUBMITTER") onPhase(phase);
      },
    } : {}),
    onTimeout: (phase) => {
      if (phase === "NETWORK") onFailure?.("NETWORK_RPC_TIMEOUT");
      else if (phase === "WASM") onFailure?.("WASM_RPC_TIMEOUT");
      else if (phase === "CONTRACT_READ") onFailure?.("CONTRACT_READ_RPC_TIMEOUT");
    },
  }, verifiedRpc);
}
