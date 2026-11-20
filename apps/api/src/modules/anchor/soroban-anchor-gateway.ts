import type { SorobanSendDiagnostic } from "./soroban-send-diagnostic.js";

export interface AnchorDeploymentConfig {
  readonly id: string;
  readonly network: "TESTNET";
  readonly networkPassphrase: string;
  readonly contractId: string;
  readonly wasmHash: string;
  readonly adminPublicAddress: string;
  readonly generation: number;
  readonly trustedConfigVersion: string;
}

export interface AnchorRequest {
  readonly deployment: AnchorDeploymentConfig;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly attemptCount: number;
  readonly leaseExpiresAt: Date;
}

export interface AnchorConfirmation {
  readonly source: "transaction_and_readback";
  readonly deploymentId: string;
  readonly contractId: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly txHash: string;
  readonly confirmedLedger: bigint;
  readonly verifiedAt: Date;
  readonly transactionStatus: "SUCCESS";
  readonly contractReadMatched: true;
}

export interface AnchorSubmissionReceipt {
  readonly deploymentId: string;
  readonly contractId: string;
  readonly messageKey: Uint8Array;
  readonly txHash: string;
  readonly transactionStatus: "PENDING";
}

export type AnchorReconciliation =
  | { readonly kind: "confirmed"; readonly evidence: AnchorConfirmation }
  | {
      readonly kind: "matching_read";
      readonly deploymentId: string;
      readonly contractId: string;
      readonly messageKey: Uint8Array;
      readonly observedContractHash: Uint8Array;
    }
  | { readonly kind: "submitted"; readonly receipt: AnchorSubmissionReceipt }
  | {
      readonly kind: "absent";
      readonly deploymentId: string;
      readonly contractId: string;
      readonly messageKey: Uint8Array;
      readonly observedContractHash: null;
      readonly priorTransactionStatus: "NOT_APPLICABLE" | "FAILED" | "NOT_FOUND_AFTER_RECONCILIATION";
    }
  | {
      readonly kind: "conflict";
      readonly deploymentId: string;
      readonly contractId: string;
      readonly messageKey: Uint8Array;
      readonly observedContractHash: Uint8Array;
    }
  | { readonly kind: "unknown"; readonly code: "RPC_UNAVAILABLE" | "RESULT_UNCERTAIN" };

/** retryable_failure is valid only when the gateway knows no transaction was accepted. */
export type AnchorSubmission =
  | { readonly kind: "submitted"; readonly receipt: AnchorSubmissionReceipt }
  | { readonly kind: "retryable_failure"; readonly code: "RPC_REJECTED" | "SIMULATION_FAILED";
      readonly sendDiagnostic?: SorobanSendDiagnostic }
  | { readonly kind: "unknown"; readonly code: "RPC_UNAVAILABLE" | "RESULT_UNCERTAIN" };

/**
 * Implementations must reconcile both transaction state and trusted contract storage.
 * They may return absent only when resubmission is safe under the configured reconciliation policy
 * and must not initiate a new send after leaseExpiresAt.
 */
export interface SorobanAnchorGateway {
  readonly trustDomain: "STELLAR_TESTNET" | "OFFLINE_LAB";
  reconcile(request: AnchorRequest, priorTxHash: string | null): Promise<AnchorReconciliation>;
  submit(request: AnchorRequest): Promise<AnchorSubmission>;
}
