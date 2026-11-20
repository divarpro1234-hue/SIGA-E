import { xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";

/** Only fixed XDR variant names and bounded numeric metadata leave the RPC boundary. */
export interface SorobanSendDiagnostic {
  readonly errorResultState: "DECODED" | "MISSING" | "INVALID";
  readonly transactionCode: string | null;
  readonly operationCode: string | null;
  readonly hostFunctionCode: string | null;
  readonly feeChargedStroops: string | null;
  readonly latestLedger: number | null;
  readonly latestLedgerCloseTime: number | null;
  readonly diagnosticEventCount: number | null;
}

export function sanitizeSorobanSendError(response: rpc.Api.SendTransactionResponse): SorobanSendDiagnostic {
  const raw = response as rpc.Api.SendTransactionResponse & { readonly errorResultXdr?: unknown };
  const supplied = raw.errorResult !== undefined || raw.errorResultXdr !== undefined;
  let result: xdr.TransactionResult | null = null;
  if (raw.errorResult instanceof xdr.TransactionResult) result = raw.errorResult;
  else if (typeof raw.errorResultXdr === "string" && raw.errorResultXdr.length <= 16_384 &&
      /^[A-Za-z0-9+/]+={0,2}$/u.test(raw.errorResultXdr)) {
    try { result = xdr.TransactionResult.fromXdr(raw.errorResultXdr, "base64"); }
    catch { result = null; }
  }
  const transaction = result?.result;
  const operation = transaction?.type === "txFailed" && transaction.results.length === 1
    ? transaction.results[0] : null;
  const hostFunction = operation?.type === "opInner" && operation.tr.type === "invokeHostFunction"
    ? operation.tr.invokeHostFunctionResult : null;
  return Object.freeze({
    errorResultState: result ? "DECODED" : supplied ? "INVALID" : "MISSING",
    transactionCode: transaction?.type ?? null,
    operationCode: operation?.type ?? null,
    hostFunctionCode: hostFunction?.type ?? null,
    feeChargedStroops: result?.feeCharged.toString() ?? null,
    latestLedger: Number.isSafeInteger(response.latestLedger) && response.latestLedger >= 0
      ? response.latestLedger : null,
    latestLedgerCloseTime: Number.isSafeInteger(response.latestLedgerCloseTime) &&
      response.latestLedgerCloseTime >= 0 ? response.latestLedgerCloseTime : null,
    diagnosticEventCount: Array.isArray(response.diagnosticEvents)
      ? response.diagnosticEvents.length : null,
  });
}
