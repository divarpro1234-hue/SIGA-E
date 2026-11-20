import { Account, xdr } from "@stellar/stellar-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StellarRpcServer } from "../../src/modules/anchor/stellar-sdk-soroban-rpc-client.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import { main } from "../../scripts/smoke-testnet-readonly.js";

// The pinned deployed WASM is deliberately not fetched in offline unit tests.
// Replace only its digest boundary; RPC, gateway, and script logic remain real.
const digestState = vi.hoisted(() => ({ value: "90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f" }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: () => ({ update: () => ({ digest: () => digestState.value }) }),
  };
});

const EXPECTED_HASH = "5277fd15c7e222efe3d2931b53010e6a1ec9da1e53b7322db9c6f5685752db97";
const EXPECTED_KEY = "3d291345eaa3a7c2a086fccbf1993bd028afc9f67198bef931bda15210f9d6a0";

function mockServer(overrides: Partial<StellarRpcServer> = {}) {
  const server: StellarRpcServer = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getContractWasmByContractId: vi.fn(async () => Uint8Array.from([0, 97, 115, 109])),
    getTransaction: vi.fn(async (txHash) => ({ status: "NOT_FOUND", txHash })),
    getAccount: vi.fn(async () => new Account(TRUSTED_TESTNET.adminPublicAddress, "1")),
    simulateTransaction: vi.fn(async () => ({
      result: { retval: xdr.ScVal.scvBytes(Buffer.from(EXPECTED_HASH, "hex")) },
    })),
    ...overrides,
  };
  const factory = vi.fn(() => server);
  const output = vi.fn();
  return { server, factory, output };
}

beforeEach(() => {
  digestState.value = TRUSTED_TESTNET.wasmHash;
});

describe("smoke Testnet read-only", () => {
  it("permanece sin red por defecto y con argumentos desconocidos", async () => {
    const { factory, output } = mockServer();
    await expect(main([], output, factory)).resolves.toBe(0);
    await expect(main(["--unknown"], output, factory)).resolves.toBe(2);
    expect(factory).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("no se realizaron consultas"));
  });

  it("valida la lectura coincidente mediante la fábrica read-only", async () => {
    const { server, factory, output } = mockServer();
    await expect(main(["--execute-readonly"], output, factory)).resolves.toBe(0);
    expect(server.getNetwork).toHaveBeenCalledOnce();
    expect(server.getContractWasmByContractId).toHaveBeenCalledWith(TRUSTED_TESTNET.contractId);
    expect(server.getAccount).toHaveBeenCalledWith(TRUSTED_TESTNET.adminPublicAddress);
    expect(server.simulateTransaction).toHaveBeenCalledOnce();
    const transaction = vi.mocked(server.simulateTransaction).mock.calls[0]?.[0];
    expect(transaction?.operations).toHaveLength(1);
    const operation = transaction?.operations[0];
    expect(operation?.type).toBe("invokeHostFunction");
    if (operation?.type !== "invokeHostFunction") throw new Error("unexpected operation");
    expect(operation.func.type).toBe("hostFunctionTypeInvokeContract");
    if (operation.func.type !== "hostFunctionTypeInvokeContract") throw new Error("unexpected host function");
    expect(operation.func.invokeContract.functionName.toString()).toBe("get_alert");
    expect(server.getTransaction).not.toHaveBeenCalled();
    expect("sendTransaction" in server).toBe(false);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("OK:"));
  });

  it("falla ante red distinta o RPC caído", async () => {
    for (const overrides of [
      { getNetwork: vi.fn(async () => ({ passphrase: "wrong" })) },
      { getNetwork: vi.fn(async () => { throw new Error("offline"); }) },
    ]) {
      const { server, factory, output } = mockServer(overrides);
      await expect(main(["--execute-readonly"], output, factory)).resolves.toBe(1);
      expect(server.simulateTransaction).not.toHaveBeenCalled();
    }
  });

  it("falla cerrado ante timeout de RPC", async () => {
    vi.useFakeTimers();
    try {
      const { factory, output } = mockServer({
        getNetwork: vi.fn(() => new Promise<{ readonly passphrase: string }>(() => {})),
      });
      const pending = main(["--execute-readonly"], output, factory);
      await vi.advanceTimersByTimeAsync(10_001);
      await expect(pending).resolves.toBe(1);
      expect(output).toHaveBeenCalledWith(expect.stringContaining("ERROR:"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("falla ante WASM discrepante o respuesta WASM malformada", async () => {
    digestState.value = "0".repeat(64);
    const mismatch = mockServer();
    await expect(main(["--execute-readonly"], mismatch.output, mismatch.factory)).resolves.toBe(1);
    expect(mismatch.server.simulateTransaction).not.toHaveBeenCalled();

    const malformed = mockServer({
      getContractWasmByContractId: vi.fn(async () => null as unknown as Uint8Array),
    });
    await expect(main(["--execute-readonly"], malformed.output, malformed.factory)).resolves.toBe(1);
  });

  it("falla ante hash distinto, ausencia o respuesta de contrato malformada", async () => {
    for (const retval of [
      xdr.ScVal.scvBytes(new Uint8Array(32).fill(0xff)),
      xdr.ScVal.scvVoid(),
      xdr.ScVal.scvBytes(new Uint8Array(31)),
    ]) {
      const { server, factory, output } = mockServer({
        simulateTransaction: vi.fn(async () => ({ result: { retval } })),
      });
      await expect(main(["--execute-readonly"], output, factory)).resolves.toBe(1);
      expect(server.getContractWasmByContractId).toHaveBeenCalledOnce();
      expect(output).toHaveBeenCalledWith(expect.stringContaining("ERROR:"));
    }
  });

  it("usa exactamente la clave sintética aprobada en get_alert", async () => {
    const { server, factory, output } = mockServer();
    await main(["--execute-readonly"], output, factory);
    const transaction = vi.mocked(server.simulateTransaction).mock.calls[0]?.[0];
    const operation = transaction?.operations[0];
    if (operation?.type !== "invokeHostFunction") throw new Error("unexpected operation");
    if (operation.func.type !== "hostFunctionTypeInvokeContract") throw new Error("unexpected host function");
    const arg = operation.func.invokeContract.args[0];
    if (arg?.type !== "scvBytes") throw new Error("unexpected argument");
    expect(Buffer.from(arg.bytes.toXdrObject())).toEqual(Buffer.from(EXPECTED_KEY, "hex"));
  });
});
