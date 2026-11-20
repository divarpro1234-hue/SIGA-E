import { describe, expect, it, vi } from "vitest";
import {
  confirmSubmittedAnchorReadback,
  reconcileSubmittedAnchorReadOnly,
  type ReadOnlySorobanRpcClient,
} from "../../src/modules/anchor/submitted-anchor-reconciliation.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import type { AnchorDeploymentConfig } from "../../src/modules/anchor/soroban-anchor-gateway.js";
import { parseSubmittedReconciliationArgs } from "../../scripts/reconcile-submitted-testnet-once.js";

const deployment: AnchorDeploymentConfig = {
  id: "trusted-testnet-deployment-1",
  network: "TESTNET",
  networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  contractId: TRUSTED_TESTNET.contractId,
  wasmHash: TRUSTED_TESTNET.wasmHash,
  adminPublicAddress: TRUSTED_TESTNET.adminPublicAddress,
  generation: 1,
  trustedConfigVersion: "TRUSTED_TESTNET_CURRENT_V1",
};
const transactionHash = "21c7bd0b60608f4cea0056ea54755e1258da27d3f141a0c42a3f26641b22865d";
const messageKey = new Uint8Array(32).fill(0x11);
const jwsHash = new Uint8Array(32).fill(0x22);
const otherHash = new Uint8Array(32).fill(0x33);
const verifiedAt = new Date("2026-11-07T12:00:00.000Z");
const endpointUrl = TRUSTED_TESTNET.endpointUrl;

function readback(value: Uint8Array | null) {
  return {
    contractId: deployment.contractId,
    method: "get_alert",
    messageKey: Uint8Array.from(messageKey),
    value,
  };
}

function results(
  transaction: unknown = { status: "SUCCESS", txHash: transactionHash, ledger: 5_565_212 },
  contractRead: unknown = readback(jwsHash),
) {
  return {
    deployment,
    transactionHash,
    messageKey,
    jwsHash,
    results: { transaction, contractRead },
    verifiedAt,
  };
}

function validReadClient(overrides: Partial<ReadOnlySorobanRpcClient> = {}) {
  return {
    getNetwork: vi.fn(async () => ({ passphrase: deployment.networkPassphrase })),
    getContractWasm: vi.fn(async () => new Uint8Array([1])),
    getTransaction: vi.fn(async () => ({
      status: "SUCCESS",
      txHash: transactionHash,
      ledger: 5_565_212,
    })),
    getAlert: vi.fn(async () => readback(jwsHash)),
    ...overrides,
  };
}

describe("reconciliación explícita de un anclaje SUBMITTED", () => {
  it("exige SOLO el UUID autorizado y no acepta otro trabajo", () => {
    expect(parseSubmittedReconciliationArgs([
      "--reconcile-submitted-testnet-once",
      "d7f5e3f6-4e58-4f20-b8ca-0e84fb792b8e",
    ])).toBe("d7f5e3f6-4e58-4f20-b8ca-0e84fb792b8e");
    expect(parseSubmittedReconciliationArgs([
      "--reconcile-submitted-testnet-once",
      "00000000-0000-4000-8000-000000000001",
    ])).toBeNull();
    expect(parseSubmittedReconciliationArgs([
      "--reconcile-submitted-testnet-once",
      "d7f5e3f6-4e58-4f20-b8ca-0e84fb792b8e",
      "extra",
    ])).toBeNull();
  });

  it("confirma solo SUCCESS con ledger positivo y lectura get_alert coincidente", () => {
    const evidence = confirmSubmittedAnchorReadback(results());
    expect(evidence).toMatchObject({
      source: "transaction_and_readback",
      txHash: transactionHash,
      confirmedLedger: 5_565_212n,
      transactionStatus: "SUCCESS",
      contractReadMatched: true,
    });
    expect(evidence.messageKey).toEqual(messageKey);
    expect(evidence.jwsHash).toEqual(jwsHash);
  });

  it("rechaza SUCCESS cuando get_alert entrega una huella diferente", () => {
    expect(() => confirmSubmittedAnchorReadback(results(
      { status: "SUCCESS", txHash: transactionHash, ledger: 5_565_212 },
      readback(otherHash),
    ))).toThrow("ANCHOR_CONTRACT_HASH_MISMATCH");
  });

  it("rechaza una transacción NOT_FOUND aunque exista una lectura coincidente", () => {
    expect(() => confirmSubmittedAnchorReadback(results(
      { status: "NOT_FOUND", txHash: transactionHash },
      readback(jwsHash),
    ))).toThrow("ANCHOR_TRANSACTION_NOT_FOUND");
  });

  it("rechaza SUCCESS sin ledger positivo", () => {
    expect(() => confirmSubmittedAnchorReadback(results(
      { status: "SUCCESS", txHash: transactionHash, ledger: 0 },
      readback(jwsHash),
    ))).toThrow("ANCHOR_TRANSACTION_RESULT_INVALID");
  });

  it("rechaza un ledger fuera del rango PostgreSQL", () => {
    expect(() => confirmSubmittedAnchorReadback(results(
      { status: "SUCCESS", txHash: transactionHash, ledger: "9223372036854775808" },
      readback(jwsHash),
    ))).toThrow("ANCHOR_TRANSACTION_RESULT_INVALID");
  });

  it("rechaza un resultado RPC que no identifica el hash de transacción consultado", () => {
    expect(() => confirmSubmittedAnchorReadback(results(
      { status: "SUCCESS", ledger: 5_565_212 },
      readback(jwsHash),
    ))).toThrow("ANCHOR_TRANSACTION_RESULT_INVALID");
  });

  it("detiene ante error RPC y no expone ni invoca ninguna capacidad de envío", async () => {
    const rpcFailure = new Error("transport details must not escape");
    const submit = vi.fn();
    const sendTransaction = vi.fn();
    const sign = vi.fn();
    const rpc = {
      ...validReadClient({
        getNetwork: vi.fn(async () => { throw rpcFailure; }),
      }),
      submit,
      sendTransaction,
      sign,
    };
    await expect(reconcileSubmittedAnchorReadOnly({
      deployment,
      endpointUrl,
      timeoutMs: 100,
      transactionHash,
      messageKey,
      jwsHash,
    }, rpc)).rejects.toBe(rpcFailure);
    expect(rpc.getContractWasm).not.toHaveBeenCalled();
    expect(rpc.getTransaction).not.toHaveBeenCalled();
    expect(rpc.getAlert).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(sendTransaction).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
  });

  it("no presenta confirmación si get_alert no encuentra la clave", () => {
    expect(() => confirmSubmittedAnchorReadback(results(
      { status: "SUCCESS", txHash: transactionHash, ledger: 5_565_212 },
      readback(null),
    ))).toThrow("ANCHOR_CONTRACT_ENTRY_NOT_FOUND");
  });
});
