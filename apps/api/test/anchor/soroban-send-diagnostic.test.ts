import { describe, expect, it } from "vitest";
import { xdr } from "@stellar/stellar-sdk";
import { sanitizeSorobanSendError } from "../../src/modules/anchor/soroban-send-diagnostic.js";

function result(body: xdr.TransactionResultResult): xdr.TransactionResult {
  return new xdr.TransactionResult({ feeCharged: 28_284n, result: body,
    ext: xdr.TransactionResultExt.v0() });
}

describe("diagnóstico saneado de sendTransaction", () => {
  it.each([
    ["txBadSeq", xdr.TransactionResultResult.txBadSeq()],
    ["txBadAuth", xdr.TransactionResultResult.txBadAuth()],
    ["txInsufficientFee", xdr.TransactionResultResult.txInsufficientFee()],
    ["txTooLate", xdr.TransactionResultResult.txTooLate()],
    ["txSorobanInvalid", xdr.TransactionResultResult.txSorobanInvalid()],
  ])("extrae %s del XDR parseado sin divulgar el XDR", (code, body) => {
    const diagnostic = sanitizeSorobanSendError({
      status: "ERROR", hash: "ab".repeat(32), latestLedger: 123,
      latestLedgerCloseTime: 1, errorResult: result(body),
      diagnosticEvents: [{}] as never,
    });
    expect(diagnostic).toEqual({ errorResultState: "DECODED", transactionCode: code,
      operationCode: null, hostFunctionCode: null, feeChargedStroops: "28284",
      latestLedger: 123, latestLedgerCloseTime: 1, diagnosticEventCount: 1 });
    expect(JSON.stringify(diagnostic)).not.toContain("AAAA");
  });

  it("extrae el código de la operación Soroban y acepta XDR bruto solo como dato de entrada", () => {
    const xdrResult = result(xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(
        xdr.InvokeHostFunctionResult.invokeHostFunctionResourceLimitExceeded())),
    ]));
    const diagnostic = sanitizeSorobanSendError({
      status: "ERROR", hash: "ab".repeat(32), latestLedger: 124,
      latestLedgerCloseTime: 1, errorResultXdr: xdrResult.toXdr("base64"),
    } as never);
    expect(diagnostic).toMatchObject({ transactionCode: "txFailed",
      operationCode: "opInner", hostFunctionCode: "invokeHostFunctionResourceLimitExceeded",
      feeChargedStroops: "28284" });
    expect(JSON.stringify(diagnostic)).not.toContain(xdrResult.toXdr("base64"));
  });

  it("distingue falta de comisión reembolsable y error de autorización de operación", () => {
    const refundable = result(xdr.TransactionResultResult.txFailed([
      xdr.OperationResult.opInner(xdr.OperationResultTr.invokeHostFunction(
        xdr.InvokeHostFunctionResult.invokeHostFunctionInsufficientRefundableFee())),
    ]));
    expect(sanitizeSorobanSendError({ status: "ERROR", hash: "ab".repeat(32),
      latestLedger: 126, latestLedgerCloseTime: 1, errorResult: refundable })).toMatchObject({
      transactionCode: "txFailed", operationCode: "opInner",
      hostFunctionCode: "invokeHostFunctionInsufficientRefundableFee",
    });
    const authorization = result(xdr.TransactionResultResult.txFailed([xdr.OperationResult.opBadAuth()]));
    expect(sanitizeSorobanSendError({ status: "ERROR", hash: "ab".repeat(32),
      latestLedger: 126, latestLedgerCloseTime: 1, errorResult: authorization })).toMatchObject({
      transactionCode: "txFailed", operationCode: "opBadAuth", hostFunctionCode: null,
    });
  });

  it("indica XDR ausente o inválido sin copiar contenido ni inventar causa", () => {
    const base = { status: "ERROR", hash: "ab".repeat(32), latestLedger: 125,
      latestLedgerCloseTime: 1 } as const;
    expect(sanitizeSorobanSendError(base)).toMatchObject({
      errorResultState: "MISSING", transactionCode: null, diagnosticEventCount: null,
    });
    const invalid = sanitizeSorobanSendError({ ...base, errorResultXdr: "secret-malformed-xdr" } as never);
    expect(invalid).toMatchObject({ errorResultState: "INVALID", transactionCode: null });
    expect(JSON.stringify(invalid)).not.toContain("secret-malformed-xdr");
  });
});
