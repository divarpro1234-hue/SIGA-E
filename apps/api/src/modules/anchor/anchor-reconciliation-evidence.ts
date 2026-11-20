import type {
  AnchorConfirmation,
  AnchorDeploymentConfig,
} from "./soroban-anchor-gateway.js";
import type { SorobanContractReadResult } from "./soroban-testnet-anchor-gateway.js";

const HASH_PATTERN = /^[A-Fa-f0-9]{64}$/u;
const MAX_DATABASE_BIGINT = (1n << 63n) - 1n;

export type AnchorTransactionResult =
  | { readonly status: "SUCCESS"; readonly ledger: bigint }
  | { readonly status: "FAILED" }
  | { readonly status: "NOT_FOUND" | "PENDING" }
  | { readonly status: "INVALID" };

export function equalAnchorBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && Buffer.from(left).equals(Buffer.from(right));
}

export function decodeAnchorTransaction(
  value: unknown,
  expectedHash: string,
): AnchorTransactionResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { status: "INVALID" };
  }
  const response = value as Record<string, unknown>;
  if ("txHash" in response &&
      (typeof response["txHash"] !== "string" ||
        response["txHash"].toLowerCase() !== expectedHash.toLowerCase())) {
    return { status: "INVALID" };
  }
  if (response["status"] === "FAILED") return { status: "FAILED" };
  if (response["status"] === "NOT_FOUND") return { status: "NOT_FOUND" };
  if (response["status"] === "PENDING") return { status: "PENDING" };
  if (response["status"] !== "SUCCESS") return { status: "INVALID" };

  const ledger = response["ledger"];
  if (typeof ledger === "number" && Number.isSafeInteger(ledger) && ledger > 0) {
    const parsedLedger = BigInt(ledger);
    return parsedLedger <= MAX_DATABASE_BIGINT
      ? { status: "SUCCESS", ledger: parsedLedger }
      : { status: "INVALID" };
  }
  if (typeof ledger === "string" && /^[1-9][0-9]*$/u.test(ledger)) {
    try {
      const parsedLedger = BigInt(ledger);
      return parsedLedger <= MAX_DATABASE_BIGINT
        ? { status: "SUCCESS", ledger: parsedLedger }
        : { status: "INVALID" };
    } catch {
      return { status: "INVALID" };
    }
  }
  return { status: "INVALID" };
}

export function decodeAnchorContractRead(
  value: unknown,
  deployment: AnchorDeploymentConfig,
  messageKey: Uint8Array,
): Uint8Array | null | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const read = value as Partial<SorobanContractReadResult>;
  if (read.contractId !== deployment.contractId || read.method !== "get_alert" ||
      !(read.messageKey instanceof Uint8Array) ||
      !equalAnchorBytes(read.messageKey, messageKey) || !("value" in read)) {
    return undefined;
  }
  if (read.value === null) return null;
  if (!(read.value instanceof Uint8Array) || read.value.length !== 32) return undefined;
  return Uint8Array.from(read.value);
}

export function createAnchorConfirmation(input: {
  readonly deployment: AnchorDeploymentConfig;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly txHash: string;
  readonly transaction: AnchorTransactionResult;
  readonly observedContractHash: Uint8Array | null | undefined;
  readonly verifiedAt: Date;
}): AnchorConfirmation | null {
  if (!HASH_PATTERN.test(input.txHash) || input.transaction.status !== "SUCCESS" ||
      input.transaction.ledger <= 0n ||
      !(input.observedContractHash instanceof Uint8Array) ||
      !equalAnchorBytes(input.observedContractHash, input.jwsHash) ||
      input.messageKey.length !== 32 || input.jwsHash.length !== 32 ||
      !Number.isFinite(input.verifiedAt.getTime())) {
    return null;
  }
  return {
    source: "transaction_and_readback",
    deploymentId: input.deployment.id,
    contractId: input.deployment.contractId,
    messageKey: Uint8Array.from(input.messageKey),
    jwsHash: Uint8Array.from(input.jwsHash),
    txHash: input.txHash.toLowerCase(),
    confirmedLedger: input.transaction.ledger,
    verifiedAt: new Date(input.verifiedAt),
    transactionStatus: "SUCCESS",
    contractReadMatched: true,
  };
}
