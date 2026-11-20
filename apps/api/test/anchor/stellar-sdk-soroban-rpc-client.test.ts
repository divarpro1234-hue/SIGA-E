import { Account, rpc, StrKey, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  StellarSdkSorobanRpcClient,
  buildRegisterAlertInvocation,
  decodeOptionBytesN32,
  encodeBytesN32,
  type StellarRpcServer,
} from "../../src/modules/anchor/stellar-sdk-soroban-rpc-client.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const ENDPOINT_URL = "https://soroban-testnet.stellar.org";
const MESSAGE_KEY = new Uint8Array(32).fill(0x11);
const JWS_HASH = new Uint8Array(32).fill(0x22);
const CONTRACT_ID = StrKey.encodeContract(new Uint8Array(32).fill(0x01));
const OTHER_CONTRACT_ID = StrKey.encodeContract(new Uint8Array(32).fill(0x03));
const ADMIN_ADDRESS = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x02));
const deployment = {
  id: "deployment-test-1",
  network: "TESTNET" as const,
  networkPassphrase: TESTNET_PASSPHRASE,
  contractId: CONTRACT_ID,
  wasmHash: "cd".repeat(32),
  adminPublicAddress: ADMIN_ADDRESS,
  generation: 1,
  trustedConfigVersion: "trusted-testnet-v1",
};

function createHarness(options: {
  readonly passphrase?: string;
  readonly transactionStatus?: string;
  readonly transactionHash?: string;
  readonly ledger?: number;
  readonly returnValue?: xdr.ScVal;
  readonly simulateError?: string;
} = {}) {
  const server: StellarRpcServer = {
    getNetwork: vi.fn(async () => ({
      passphrase: options.passphrase ?? TESTNET_PASSPHRASE,
    })),
    getTransaction: vi.fn(async (transactionHash) => ({
      status: options.transactionStatus ?? rpc.Api.GetTransactionStatus.NOT_FOUND,
      txHash: options.transactionHash ?? transactionHash,
      ...(options.ledger !== undefined ? { ledger: options.ledger } : {}),
    })),
    getAccount: vi.fn(async (address) => new Account(address, "1")),
    simulateTransaction: vi.fn(async () => options.simulateError !== undefined
      ? { error: options.simulateError }
      : { result: { retval: options.returnValue ?? xdr.ScVal.scvVoid() } }),
  };
  const serverFactory = vi.fn((_endpointUrl: string, _timeoutMs: number) => server);
  const client = new StellarSdkSorobanRpcClient({
    endpointUrl: ENDPOINT_URL,
    deployment,
    timeoutMs: 1_000,
  }, serverFactory);
  return { client, server, serverFactory };
}

describe("StellarSdkSorobanRpcClient", () => {
  it("crea el cliente RPC de forma perezosa con timeout y transporte HTTPS", async () => {
    const { client, serverFactory } = createHarness();
    expect(serverFactory).not.toHaveBeenCalled();

    await client.getNetwork({
      endpointUrl: ENDPOINT_URL,
      signal: new AbortController().signal,
    });

    expect(serverFactory).toHaveBeenCalledWith(`${ENDPOINT_URL}/`, 1_000);
  });

  it("normaliza la identidad de red Testnet", async () => {
    const { client } = createHarness();
    await expect(client.getNetwork({
      endpointUrl: ENDPOINT_URL,
      signal: new AbortController().signal,
    })).resolves.toEqual({ passphrase: TESTNET_PASSPHRASE });
  });

  it("rechaza el endpoint no confiable antes de crear un servidor", async () => {
    const { client, serverFactory } = createHarness();
    await expect(client.getNetwork({
      endpointUrl: "https://rpc.example.invalid",
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_RPC_ENDPOINT_REJECTED");
    expect(serverFactory).not.toHaveBeenCalled();
  });

  it("codifica BytesN<32> como ScVal scvBytes y rechaza longitudes inválidas", () => {
    const encoded = encodeBytesN32(MESSAGE_KEY);
    expect(encoded.type).toBe("scvBytes");
    if (encoded.type === "scvBytes") {
      expect(encoded.value.toXdrObject()).toEqual(MESSAGE_KEY);
    }
    expect(() => encodeBytesN32(new Uint8Array(31))).toThrow(
      "STELLAR_BYTES_N32_INVALID",
    );
  });

  it("decodifica estrictamente Option<BytesN<32>> usando scvVoid o scvBytes", () => {
    expect(decodeOptionBytesN32(xdr.ScVal.scvVoid())).toBeNull();
    expect(decodeOptionBytesN32(xdr.ScVal.scvBytes(JWS_HASH))).toEqual(JWS_HASH);
    expect(() => decodeOptionBytesN32(xdr.ScVal.scvBytes(new Uint8Array(31)))).toThrow(
      "STELLAR_OPTION_BYTES_N32_INVALID",
    );
    expect(() => decodeOptionBytesN32(xdr.ScVal.scvBool(true))).toThrow(
      "STELLAR_OPTION_BYTES_N32_INVALID",
    );
  });

  it("construye la invocación register_alert con el deployment y los dos BytesN", () => {
    const operation = buildRegisterAlertInvocation(deployment, MESSAGE_KEY, JWS_HASH);
    expect(operation.body.type).toBe("invokeHostFunction");
    if (operation.body.type !== "invokeHostFunction") return;

    const hostFunction = operation.body.value.hostFunction;
    expect(hostFunction.type).toBe("hostFunctionTypeInvokeContract");
    if (hostFunction.type !== "hostFunctionTypeInvokeContract") return;
    const contractAddress = hostFunction.value.contractAddress;
    expect(contractAddress.type).toBe("scAddressTypeContract");
    if (contractAddress.type !== "scAddressTypeContract") return;
    expect(StrKey.encodeContract(contractAddress.contractId.toXdrObject())).toBe(CONTRACT_ID);
    expect(hostFunction.value.functionName.toString()).toBe("register_alert");
    expect(hostFunction.value.args).toHaveLength(2);
    expect(hostFunction.value.args[0]?.type).toBe("scvBytes");
    expect(hostFunction.value.args[1]?.type).toBe("scvBytes");
  });

  it("normaliza SUCCESS, FAILED y NOT_FOUND sin inferir confirmación", async () => {
    const statuses = [
      { status: "SUCCESS", ledger: 91_234, expected: { status: "SUCCESS", ledger: 91_234 } },
      { status: "FAILED", expected: { status: "FAILED" } },
      { status: "NOT_FOUND", expected: { status: "NOT_FOUND" } },
    ] as const;

    for (const item of statuses) {
      const { client } = createHarness({
        transactionStatus: item.status,
        ...("ledger" in item ? { ledger: item.ledger } : {}),
      });
      await expect(client.getTransaction({
        endpointUrl: ENDPOINT_URL,
        transactionHash: "ab".repeat(32),
        signal: new AbortController().signal,
      })).resolves.toMatchObject(item.expected);
    }
  });

  it("rechaza una respuesta de transacción para otro hash", async () => {
    const { client } = createHarness({ transactionHash: "cd".repeat(32) });
    await expect(client.getTransaction({
      endpointUrl: ENDPOINT_URL,
      transactionHash: "ab".repeat(32),
      signal: new AbortController().signal,
    })).resolves.toEqual({ status: "INVALID" });
  });

  it("simula get_alert en el contrato configurado y devuelve el hash XDR", async () => {
    const { client, server } = createHarness({
      returnValue: xdr.ScVal.scvBytes(JWS_HASH),
    });
    await expect(client.getAlert({
      endpointUrl: ENDPOINT_URL,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: CONTRACT_ID,
      messageKey: MESSAGE_KEY,
      signal: new AbortController().signal,
    })).resolves.toEqual({
      contractId: CONTRACT_ID,
      method: "get_alert",
      messageKey: MESSAGE_KEY,
      value: JWS_HASH,
    });
    expect(server.getAccount).toHaveBeenCalledWith(ADMIN_ADDRESS);
    expect(server.simulateTransaction).toHaveBeenCalledOnce();
  });

  it("devuelve null únicamente para Option None y no consulta otro contrato", async () => {
    const { client, server } = createHarness();
    await expect(client.getAlert({
      endpointUrl: ENDPOINT_URL,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: CONTRACT_ID,
      messageKey: MESSAGE_KEY,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({ value: null });

    await expect(client.getAlert({
      endpointUrl: ENDPOINT_URL,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: OTHER_CONTRACT_ID,
      messageKey: MESSAGE_KEY,
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_DEPLOYMENT_REJECTED");
    expect(server.simulateTransaction).toHaveBeenCalledOnce();
  });

  it("sanea errores de simulación y transporte", async () => {
    const failedSimulation = createHarness({ simulateError: "sensitive rpc detail" });
    await expect(failedSimulation.client.getAlert({
      endpointUrl: ENDPOINT_URL,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: CONTRACT_ID,
      messageKey: MESSAGE_KEY,
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_RPC_CONTRACT_READ_FAILED");

    const failedNetwork = createHarness();
    failedNetwork.server.getNetwork = vi.fn(async () => {
      throw new Error("sensitive transport detail");
    });
    await expect(failedNetwork.client.getNetwork({
      endpointUrl: ENDPOINT_URL,
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_RPC_NETWORK_QUERY_FAILED");
  });

  it("preserva el código de timeout RPC sin exponer el detalle del transporte", async () => {
    const networkTimeout = createHarness();
    networkTimeout.server.getNetwork = vi.fn(async () => {
      throw new Error("timeout of 1000ms exceeded");
    });
    await expect(networkTimeout.client.getNetwork({
      endpointUrl: ENDPOINT_URL,
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_RPC_TIMEOUT");

    const wasmTimeout = createHarness();
    wasmTimeout.server.getContractWasmByContractId = vi.fn(async () => {
      throw new Error("timeout of 1000ms exceeded");
    });
    await expect(wasmTimeout.client.getContractWasm({
      endpointUrl: ENDPOINT_URL,
      contractId: deployment.contractId,
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_RPC_TIMEOUT");
  });

  it("rechaza de forma segura una señal ya cancelada antes de abrir el servidor", async () => {
    const { client, serverFactory } = createHarness();
    const controller = new AbortController();
    controller.abort();
    await expect(client.getNetwork({
      endpointUrl: ENDPOINT_URL,
      signal: controller.signal,
    })).rejects.toThrow("STELLAR_RPC_ABORTED");
    expect(serverFactory).not.toHaveBeenCalled();
  });

  it("rechaza deployment, passphrase o entrada no autorizados", async () => {
    expect(() => new StellarSdkSorobanRpcClient({
      endpointUrl: ENDPOINT_URL,
      deployment: { ...deployment, networkPassphrase: "not Testnet" },
      timeoutMs: 1_000,
    })).toThrow("STELLAR_SDK_RPC_CONFIGURATION_INVALID");

    const { client } = createHarness();
    await expect(client.getAlert({
      endpointUrl: ENDPOINT_URL,
      networkPassphrase: "Public Global Stellar Network ; September 2015",
      contractId: CONTRACT_ID,
      messageKey: MESSAGE_KEY,
      signal: new AbortController().signal,
    })).rejects.toThrow("STELLAR_DEPLOYMENT_REJECTED");
  });
});
