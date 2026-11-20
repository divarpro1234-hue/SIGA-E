import { Account, xdr } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadOnlyTestnetGateway } from "../../src/modules/anchor/create-read-only-testnet-gateway.js";
import { TRUSTED_TESTNET, matchesTrustedTestnetDeployment, normalizeTrustedTestnetRpcUrl } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import type { StellarRpcServer } from "../../src/modules/anchor/stellar-sdk-soroban-rpc-client.js";

const deployment = {
  id: "deployment-read-only",
  network: TRUSTED_TESTNET.network,
  networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  contractId: TRUSTED_TESTNET.contractId,
  wasmHash: TRUSTED_TESTNET.wasmHash,
  adminPublicAddress: TRUSTED_TESTNET.adminPublicAddress,
  generation: 1,
  trustedConfigVersion: "testnet-public-v1",
};
const request = {
  deployment,
  messageKey: new Uint8Array(32).fill(1),
  jwsHash: new Uint8Array(32).fill(2),
  attemptCount: 1,
  leaseExpiresAt: new Date(Date.now() + 60_000),
};

function harness(
  overrides: Partial<StellarRpcServer> = {},
  timeoutMs = 20,
  onFailure?: NonNullable<Parameters<typeof createReadOnlyTestnetGateway>[3]>,
) {
  const server: StellarRpcServer = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getContractWasmByContractId: vi.fn(async () => new Uint8Array([1, 2, 3])),
    getTransaction: vi.fn(async (txHash) => ({ status: "NOT_FOUND", txHash })),
    getAccount: vi.fn(async () => new Account(TRUSTED_TESTNET.adminPublicAddress, "1")),
    simulateTransaction: vi.fn(async () => ({ result: { retval: xdr.ScVal.scvVoid() } })),
    ...overrides,
  };
  const factory = vi.fn(() => server);
  const gateway = createReadOnlyTestnetGateway({
    deployment,
    endpointUrl: TRUSTED_TESTNET.endpointUrl,
    timeoutMs,
  }, factory, undefined, onFailure);
  return { gateway, server, factory };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("deployment Testnet público y gateway de solo lectura", () => {
  it("acepta la identidad aprobada y ambas variantes exactas de URL", () => {
    expect(matchesTrustedTestnetDeployment(deployment)).toBe(true);
    expect(normalizeTrustedTestnetRpcUrl(TRUSTED_TESTNET.endpointUrl.slice(0, -1)))
      .toBe(TRUSTED_TESTNET.endpointUrl);
    expect(normalizeTrustedTestnetRpcUrl(TRUSTED_TESTNET.endpointUrl))
      .toBe(TRUSTED_TESTNET.endpointUrl);
    expect(() => createReadOnlyTestnetGateway({
      deployment, endpointUrl: TRUSTED_TESTNET.endpointUrl.slice(0, -1), timeoutMs: 20,
    }, vi.fn())).not.toThrow();
  });

  it.each([
    ["contract ID", { contractId: "C" + "A".repeat(55) }],
    ["admin", { adminPublicAddress: "G" + "A".repeat(55) }],
    ["WASM", { wasmHash: "0".repeat(64) }],
    ["passphrase", { networkPassphrase: "other" }],
  ])("rechaza %s diferente aunque PostgreSQL lo entregue", (_label, change) => {
    const altered = { ...deployment, ...change };
    expect(matchesTrustedTestnetDeployment(altered)).toBe(false);
    expect(() => createReadOnlyTestnetGateway({
      deployment: altered, endpointUrl: TRUSTED_TESTNET.endpointUrl, timeoutMs: 20,
    })).toThrow("SOROBAN_TRUSTED_DEPLOYMENT_MISMATCH");
  });

  it.each([
    "http://soroban-testnet.stellar.org/",
    "https://evil.example/",
    "https://soroban-testnet.stellar.org:443/",
    "https://user@soroban-testnet.stellar.org/",
    "https://soroban-testnet.stellar.org/?x=1",
    "https://soroban-testnet.stellar.org/other",
  ])("rechaza URL RPC inesperada: %s", (url) => {
    expect(() => normalizeTrustedTestnetRpcUrl(url)).toThrow("SOROBAN_RPC_ENDPOINT_REJECTED");
  });

  it("mantiene lectura incierta ante WASM distinto, sin consultar el contrato", async () => {
    const { gateway, server } = harness();
    expect((await gateway.reconcile(request, null)).kind).toBe("unknown");
    expect(server.getContractWasmByContractId).toHaveBeenCalledWith(TRUSTED_TESTNET.contractId);
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("mantiene lectura incierta ante timeout, RPC fallido y respuesta malformada", async () => {
    const failures: Partial<StellarRpcServer>[] = [
      { getNetwork: vi.fn(() => new Promise<{ readonly passphrase: string }>(() => {})) },
      { getNetwork: vi.fn(async () => { throw new Error("offline"); }) },
      { getNetwork: vi.fn(async () => ({ passphrase: 42 as unknown as string })) },
      { getContractWasmByContractId: vi.fn(async () => null as unknown as Uint8Array) },
    ];
    for (const failure of failures) {
      const { gateway, server } = harness(failure, 5);
      expect((await gateway.reconcile(request, null)).kind).toBe("unknown");
      expect(server.simulateTransaction).not.toHaveBeenCalled();
    }
  });

  it("reporta timeout WASM en la fase WASM sin exponer errores ni pasar a CONTRACT_READ", async () => {
    vi.useFakeTimers();
    const failures: string[] = [];
    const { gateway, server } = harness({
      getContractWasmByContractId: vi.fn(() =>
        new Promise<Uint8Array>((_resolve, reject) => {
          setTimeout(() => reject(new Error("sensitive delayed transport failure")), 21);
        })),
    }, 20, (code) => failures.push(code));
    const pending = gateway.reconcile(request, null);

    await vi.advanceTimersByTimeAsync(20);
    await expect(pending).resolves.toEqual({ kind: "unknown", code: "RPC_UNAVAILABLE" });
    expect(failures).toEqual(["WASM_RPC_TIMEOUT"]);
    expect(server.simulateTransaction).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(failures).toEqual(["WASM_RPC_TIMEOUT"]);
    expect(server.simulateTransaction).not.toHaveBeenCalled();
  });

  it("no posee firmante ni envía transacciones, incluso al solicitar submit", async () => {
    const { gateway, server, factory } = harness();
    expect(factory).not.toHaveBeenCalled();
    await expect(gateway.submit(request)).rejects.toThrow("SOROBAN_SUBMISSION_DISABLED");
    expect(factory).not.toHaveBeenCalled();
    expect(server.getAccount).not.toHaveBeenCalled();
    expect("sendTransaction" in server).toBe(false);
  });
});
