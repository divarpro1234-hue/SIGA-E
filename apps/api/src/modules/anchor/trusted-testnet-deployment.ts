import { StrKey } from "@stellar/stellar-sdk";
import type { AnchorDeploymentConfig } from "./soroban-anchor-gateway.js";

/** Public deployment identity reviewed independently of PostgreSQL. */
export const TRUSTED_TESTNET = Object.freeze({
  network: "TESTNET",
  networkPassphrase: "Test SDF Network ; September 2015",
  endpointUrl: "https://soroban-testnet.stellar.org/",
  contractId: "CAQLM6JQLLWCNZ5JSZRQ522VAL34DU2C7HXTLLQU7GXNGNLDLDETQZS5",
  adminPublicAddress: "GDTTA7YMMQGV3NZ37VBKIIQAVG5NGLCCVMEBKVPTGAPTPRWH3E2AXNNA",
  wasmHash: "90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f",
} as const);

const RPC_URL = TRUSTED_TESTNET.endpointUrl;

export function normalizeTrustedTestnetRpcUrl(value: string): string {
  if (value !== RPC_URL && value !== RPC_URL.slice(0, -1)) {
    throw new TypeError("SOROBAN_RPC_ENDPOINT_REJECTED");
  }
  return RPC_URL;
}

export function matchesTrustedTestnetDeployment(value: AnchorDeploymentConfig): boolean {
  return value.network === TRUSTED_TESTNET.network &&
    value.networkPassphrase === TRUSTED_TESTNET.networkPassphrase &&
    value.contractId === TRUSTED_TESTNET.contractId &&
    value.adminPublicAddress === TRUSTED_TESTNET.adminPublicAddress &&
    value.wasmHash === TRUSTED_TESTNET.wasmHash &&
    typeof value.id === "string" && value.id.length > 0 &&
    Number.isSafeInteger(value.generation) && value.generation > 0 &&
    typeof value.trustedConfigVersion === "string" && value.trustedConfigVersion.length > 0;
}

// Catch an accidental edit to the pinned public identifiers during construction.
if (StrKey.decodeContract(TRUSTED_TESTNET.contractId).length !== 32 ||
    StrKey.decodeEd25519PublicKey(TRUSTED_TESTNET.adminPublicAddress).length !== 32 ||
    !/^[0-9a-f]{64}$/u.test(TRUSTED_TESTNET.wasmHash)) {
  throw new TypeError("TRUSTED_TESTNET_CONFIGURATION_INVALID");
}
