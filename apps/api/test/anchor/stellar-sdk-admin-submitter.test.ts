import { Account, Contract, Keypair, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareAdminRegisterAlert, SorobanSubmitterError, StellarSdkSorobanAdminSubmitter, type AdminSubmitterConfig,
  type SorobanSubmitRpc, type SorobanTransactionSigner,
} from "../../src/modules/anchor/stellar-sdk-admin-submitter.js";
import { SorobanTestnetAnchorGateway } from "../../src/modules/anchor/soroban-testnet-anchor-gateway.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import { addressAuthorization, registerAlertAuthorization } from "./soroban-auth-fixtures.js";

const digestState = vi.hoisted(() => ({ value: "90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f" }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: () => ({ update: () => ({ digest: () => digestState.value }) }) };
});

const deployment = {
  id: "submitter-unit-fixture", network: TRUSTED_TESTNET.network,
  networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  contractId: TRUSTED_TESTNET.contractId, wasmHash: TRUSTED_TESTNET.wasmHash,
  adminPublicAddress: TRUSTED_TESTNET.adminPublicAddress,
  generation: 1, trustedConfigVersion: "submitter-unit-fixture-v1",
};
const config: AdminSubmitterConfig = {
  deployment, endpointUrl: TRUSTED_TESTNET.endpointUrl, timeoutMs: 100,
  transactionTimeoutSeconds: 30, baseFeeStroops: 100, maxFeeStroops: 2_000n,
  maxInstructions: 1_000_000, maxDiskReadBytes: 10_000, maxWriteBytes: 10_000,
};
const key = new Uint8Array(32).fill(1);
const hash = new Uint8Array(32).fill(2);
const signal = new AbortController().signal;
const input = {
  endpointUrl: TRUSTED_TESTNET.endpointUrl,
  networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  contractId: TRUSTED_TESTNET.contractId, messageKey: key, jwsHash: hash, signal,
};

function simulation(overrides: Record<string, unknown> = {}) {
  return {
    id: "unit", latestLedger: 1, events: [], _parsed: true,
    transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100).setResourceFee(100),
    minResourceFee: "100",
    result: {
      auth: [registerAlertAuthorization({ messageKey: key, jwsHash: hash })],
      retval: xdr.ScVal.scvVoid(),
    },
    ...overrides,
  };
}

function signedXdr(transactionXdr: string, mutate?: (tx: Transaction) => Transaction): string {
  const tx = new Transaction(transactionXdr, TRUSTED_TESTNET.networkPassphrase);
  const envelope = (mutate?.(tx) ?? tx).toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("unexpected envelope");
  const signature = new xdr.DecoratedSignature({
    hint: Keypair.fromPublicKey(TRUSTED_TESTNET.adminPublicAddress).signatureHint(),
    signature: new Uint8Array(64).fill(0x55),
  });
  return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
    tx: envelope.value.tx, signatures: [signature],
  })).toXdr("base64");
}

function harness(options: { enabled?: boolean; signer?: SorobanTransactionSigner; overrides?: Partial<SorobanSubmitRpc> } = {}) {
  const transport: SorobanSubmitRpc = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getContractWasmByContractId: vi.fn(async () => Uint8Array.from([0, 97, 115, 109])),
    getAccount: vi.fn(async () => new Account(TRUSTED_TESTNET.adminPublicAddress, "1")),
    simulateTransaction: vi.fn(async () => simulation()),
    sendTransaction: vi.fn(async (tx) => ({
      status: "PENDING" as const,
      hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 1, latestLedgerCloseTime: 1,
    })),
    ...options.overrides,
  };
  const signer = options.signer ?? {
    publicAddress: TRUSTED_TESTNET.adminPublicAddress,
    signPreparedXdr: vi.fn(async ({ transactionXdr }: { transactionXdr: string }) => signedXdr(transactionXdr)),
  };
  const submitter = new StellarSdkSorobanAdminSubmitter({
    ...config, submissionEnabled: options.enabled ?? true,
  }, transport, signer);
  return { submitter, transport, signer };
}

beforeEach(() => {
  digestState.value = TRUSTED_TESTNET.wasmHash;
  vi.spyOn(Keypair.prototype, "verify").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("StellarSdkSorobanAdminSubmitter", () => {
  it("reintenta únicamente un timeout de lectura WASM del modo manual Testnet", async () => {
    const manualConfig: AdminSubmitterConfig = {
      ...config,
      maxFeeStroops: 3_000_000n,
      feeScope: "trusted-manual-testnet",
      wasmReadTimeoutMs: 20_000,
      wasmReadRetries: 1,
    };
    const { transport } = harness();
    const attempts: Array<[number, number, string | null]> = [];
    let wasmCalls = 0;
    await expect(prepareAdminRegisterAlert({
      config: {
        ...manualConfig,
        onWasmReadAttempt: (attempt, duration, code) => attempts.push([attempt, duration, code]),
      },
      rpcTransport: transport,
      contractId: TRUSTED_TESTNET.contractId,
      messageKey: key,
      jwsHash: hash,
      signal,
      read: (operation) => operation(),
      readWasm: async (operation) => {
        wasmCalls += 1;
        const observed = await operation();
        if (wasmCalls === 1) throw new SorobanSubmitterError("RPC_TIMEOUT");
        return observed;
      },
    })).resolves.toBeInstanceOf(Transaction);
    expect(wasmCalls).toBe(2);
    expect(transport.getContractWasmByContractId).toHaveBeenCalledTimes(2);
    expect(transport.sendTransaction).not.toHaveBeenCalled();
    expect(attempts).toEqual([
      [1, expect.any(Number), "WASM_RPC_TIMEOUT"],
      [2, expect.any(Number), null],
    ]);
  });

  it("no reintenta WASM discrepante aunque la política permita reintentar timeouts", async () => {
    const manualConfig: AdminSubmitterConfig = {
      ...config,
      maxFeeStroops: 40_000n,
      feeScope: "trusted-manual-testnet",
      wasmReadTimeoutMs: 20_000,
      wasmReadRetries: 1,
    };
    const { transport } = harness();
    const attempts: Array<[number, number, string | null]> = [];
    digestState.value = "0".repeat(64);
    await expect(prepareAdminRegisterAlert({
      config: {
        ...manualConfig,
        onWasmReadAttempt: (attempt, duration, code) => attempts.push([attempt, duration, code]),
      },
      rpcTransport: transport,
      contractId: TRUSTED_TESTNET.contractId,
      messageKey: key,
      jwsHash: hash,
      signal,
      read: (operation) => operation(),
    })).rejects.toThrow("PREFLIGHT_REJECTED");
    expect(transport.getContractWasmByContractId).toHaveBeenCalledOnce();
    expect(transport.simulateTransaction).not.toHaveBeenCalled();
    expect(attempts).toEqual([[1, expect.any(Number), "WASM_IDENTITY_MISMATCH"]]);
  });

  it("calcula el total en stroops con BigInt y exige coincidencia exacta con el XDR", async () => {
    const samples = [
      { min: "1899", resource: 1899, rule: "WITHIN_LIMIT", total: "1999" },
      { min: "1900", resource: 1900, rule: "WITHIN_LIMIT", total: "2000" },
      { min: "1901", resource: 1901, rule: "CALCULATED_TOTAL_EXCEEDS_MAX", total: "2001", error: "SIMULATION_FEE_LIMIT_EXCEEDED" },
      { min: "100", resource: 200, rule: "ASSEMBLED_FEE_MISMATCH", total: "200", error: "SIMULATION_ASSEMBLED_FEE_MISMATCH" },
      { min: "9007199254740993", resource: 100, rule: "CALCULATED_TOTAL_EXCEEDS_MAX", total: "9007199254741093", error: "SIMULATION_FEE_LIMIT_EXCEEDED" },
      { min: "-1", resource: 100, rule: "INVALID_MIN_RESOURCE_FEE", total: null, error: "SIMULATION_FEE_INVALID" },
      { min: "1.5", resource: 100, rule: "INVALID_MIN_RESOURCE_FEE", total: null, error: "SIMULATION_FEE_INVALID" },
    ] as const;
    for (const sample of samples) {
      const { transport, signer } = harness({ overrides: {
        simulateTransaction: vi.fn(async () => simulation({
          minResourceFee: sample.min,
          transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100).setResourceFee(sample.resource),
        }) as never),
      } });
      const onFeeDiagnostic = vi.fn();
      const operation = prepareAdminRegisterAlert({
        config, rpcTransport: transport, contractId: TRUSTED_TESTNET.contractId,
        messageKey: key, jwsHash: hash, signal,
        read: (readOperation) => readOperation(), onFeeDiagnostic,
      });
      if ("error" in sample) await expect(operation).rejects.toThrow(sample.error);
      else await expect(operation).resolves.toBeInstanceOf(Transaction);
      expect(onFeeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        baseFeeStroops: "100", minResourceFeeStroops: sample.total === null ? null : sample.min,
        calculatedTotalFeeStroops: sample.total, maxFeeStroops: "2000", rule: sample.rule,
        assembledFeeStroops: sample.rule === "WITHIN_LIMIT" ? sample.total :
          sample.rule === "ASSEMBLED_FEE_MISMATCH" ? "300" : null,
      }));
      expect(signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("rechaza comisión ausente o con tipo no textual antes de ensamblar", async () => {
    for (const value of [undefined, -1, 100]) {
      const { transport, signer } = harness({ overrides: {
        simulateTransaction: vi.fn(async () => simulation({ minResourceFee: value }) as never),
      } });
      const onFeeDiagnostic = vi.fn();
      await expect(prepareAdminRegisterAlert({ config, rpcTransport: transport,
        contractId: TRUSTED_TESTNET.contractId, messageKey: key, jwsHash: hash, signal,
        read: (operation) => operation(), onFeeDiagnostic,
      })).rejects.toThrow("SIMULATION_RESPONSE_INVALID");
      expect(onFeeDiagnostic).toHaveBeenCalledWith(expect.objectContaining({
        baseFeeStroops: "100", minResourceFeeStroops: null,
        calculatedTotalFeeStroops: null, assembledFeeStroops: null,
        maxFeeStroops: "2000", rule: "INVALID_MIN_RESOURCE_FEE",
      }));
      expect(signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("conserva 2000 stroops en el consumidor general sin política manual", async () => {
    const { transport, signer } = harness({ overrides: {
      simulateTransaction: vi.fn(async () => simulation({ minResourceFee: "28184" }) as never),
    } });
    await expect(prepareAdminRegisterAlert({ config, rpcTransport: transport,
      contractId: TRUSTED_TESTNET.contractId, messageKey: key, jwsHash: hash, signal,
      read: (operation) => operation(),
    })).rejects.toThrow("SIMULATION_FEE_LIMIT_EXCEEDED");
    expect(config.maxFeeStroops).toBe(2_000n);
    expect(signer.signPreparedXdr).not.toHaveBeenCalled();
    expect(transport.sendTransaction).not.toHaveBeenCalled();
    const expanded = { ...config, maxFeeStroops: 40_000n };
    expect(() => new StellarSdkSorobanAdminSubmitter(expanded, transport))
      .toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    await expect(prepareAdminRegisterAlert({ config: expanded, rpcTransport: transport,
      contractId: TRUSTED_TESTNET.contractId, messageKey: key, jwsHash: hash, signal,
      read: (operation) => operation(),
    })).rejects.toThrow("PREFLIGHT_REJECTED");
  });

  it("no permite aplicar la política manual a otra red, contrato o administrador", () => {
    const transport = harness().transport;
    const manual = { ...config, maxFeeStroops: 40_000n,
      feeScope: "trusted-manual-testnet" as const };
    expect(() => new StellarSdkSorobanAdminSubmitter(manual, transport)).not.toThrow();
    expect(() => new StellarSdkSorobanAdminSubmitter({
      ...manual, maxFeeStroops: 3_000_000n,
    }, transport)).not.toThrow();
    expect(() => new StellarSdkSorobanAdminSubmitter({
      ...manual, maxFeeStroops: 3_000_001n,
    }, transport)).toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    for (const maxFeeStroops of [40_000n, 3_000_000n]) {
      for (const change of [
        { networkPassphrase: "Public Global Stellar Network ; September 2015" },
        { contractId: StrKey.encodeContract(new Uint8Array(32).fill(0x33)) },
        { adminPublicAddress: StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x44)) },
      ]) {
        expect(() => new StellarSdkSorobanAdminSubmitter({
          ...manual, maxFeeStroops, deployment: { ...deployment, ...change },
        }, transport)).toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
      }
    }
  });

  it("limita el presupuesto explícito a 3.000.000 y bloquea antes de autorizar si total o XDR exceden", async () => {
    const manualConfig: AdminSubmitterConfig = {
      ...config, submissionEnabled: true, maxFeeStroops: 3_000_000n,
      feeScope: "trusted-manual-testnet",
    };
    const samples = [
      {
        minResourceFee: "2614689", resourceFee: 2_614_689,
        error: "AUTHORIZATION_DENIED", total: "2614789", assembled: "2614789",
        rule: "WITHIN_LIMIT", reachesAuthorization: true,
      },
      {
        minResourceFee: "2999901", resourceFee: 2_999_901,
        error: "SIMULATION_FEE_LIMIT_EXCEEDED", total: "3000001", assembled: null,
        rule: "CALCULATED_TOTAL_EXCEEDS_MAX", reachesAuthorization: false,
      },
      {
        minResourceFee: "2614689", resourceFee: 3_000_001,
        error: "SIMULATION_ASSEMBLED_FEE_MISMATCH", total: "2614789", assembled: "3000101",
        rule: "ASSEMBLED_FEE_MISMATCH", reachesAuthorization: false,
      },
    ] as const;

    for (const sample of samples) {
      const { transport, signer } = harness({ overrides: {
        simulateTransaction: vi.fn(async () => simulation({
          minResourceFee: sample.minResourceFee,
          transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100)
            .setResourceFee(sample.resourceFee),
        }) as never),
      } });
      const sequence: unknown[] = [];
      const submitter = new StellarSdkSorobanAdminSubmitter({
        ...manualConfig,
        onFeeDiagnostic: (diagnostic) => sequence.push(diagnostic),
        authorizeSigning: async () => {
          sequence.push("operator-approval");
          return null;
        },
      }, transport, signer);

      await expect(submitter.registerAlert(input)).rejects.toThrow(sample.error);
      expect(sequence[0]).toMatchObject({
        baseFeeStroops: "100",
        minResourceFeeStroops: sample.minResourceFee,
        calculatedTotalFeeStroops: sample.total,
        assembledFeeStroops: sample.assembled,
        maxFeeStroops: "3000000",
        rule: sample.rule,
      });
      expect(sequence.includes("operator-approval")).toBe(sample.reachesAuthorization);
      if (sample.reachesAuthorization) {
        expect(sequence[0]).not.toBe("operator-approval");
        expect(sequence[1]).toBe("operator-approval");
      }
      expect(signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("reserva los 180 segundos a la composición manual confiable y deja 30 en la general", () => {
    const transport = harness().transport;
    expect(config.transactionTimeoutSeconds).toBe(30);
    const manual = { ...config, maxFeeStroops: 40_000n,
      feeScope: "trusted-manual-testnet" as const,
      manualTimeboundWindow: true as const, transactionTimeoutSeconds: 180 };
    expect(() => new StellarSdkSorobanAdminSubmitter(manual, transport)).not.toThrow();
    expect(() => new StellarSdkSorobanAdminSubmitter({ ...config,
      manualTimeboundWindow: true, transactionTimeoutSeconds: 180 }, transport))
      .toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    for (const deploymentChange of [
      { networkPassphrase: "Public Global Stellar Network ; September 2015" },
      { contractId: StrKey.encodeContract(new Uint8Array(32).fill(0x33)) },
      { adminPublicAddress: StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x44)) },
    ]) {
      expect(() => new StellarSdkSorobanAdminSubmitter({ ...manual,
        deployment: { ...deployment, ...deploymentChange },
      }, transport)).toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    }
  });
  it("prepara una única invocación sintética y devuelve solo PENDING", async () => {
    const { submitter, transport, signer } = harness();
    const result = await submitter.registerAlert(input);
    expect(result).toMatchObject({ status: "PENDING", hash: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(transport.getNetwork).toHaveBeenCalledOnce();
    expect(transport.getContractWasmByContractId).toHaveBeenCalledWith(TRUSTED_TESTNET.contractId);
    expect(transport.simulateTransaction).toHaveBeenCalledOnce();
    expect(transport.sendTransaction).toHaveBeenCalledOnce();
    const prepared = new Transaction(vi.mocked(signer.signPreparedXdr).mock.calls[0]![0].transactionXdr,
      TRUSTED_TESTNET.networkPassphrase);
    expect(prepared.source).toBe(TRUSTED_TESTNET.adminPublicAddress);
    expect(prepared.operations).toHaveLength(1);
    expect(prepared.operations[0]?.type).toBe("invokeHostFunction");
    expect(BigInt(prepared.fee)).toBeLessThanOrEqual(config.maxFeeStroops);
    const sent = vi.mocked(transport.sendTransaction).mock.calls[0]![0];
    expect(sent.toXdr()).toBe(await vi.mocked(signer.signPreparedXdr).mock.results[0]!.value);
    expect(sent.hash()).toEqual(prepared.hash());
    expect(sent.sequence).toBe(prepared.sequence);
    expect(sent.sequence).toBe("2"); // getAccount returned sequence 1; builder increments once.
    const sentAuth = sent.operations[0];
    const preparedAuth = prepared.operations[0];
    if (sentAuth?.type !== "invokeHostFunction" || preparedAuth?.type !== "invokeHostFunction" ||
        !sentAuth.auth || !preparedAuth.auth) throw new Error();
    expect(sentAuth.auth.map((entry) => entry.toXdr("base64")))
      .toEqual(preparedAuth.auth.map((entry) => entry.toXdr("base64")));
  });

  it("no envía si el lease vence durante la firma", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const signer: SorobanTransactionSigner = {
      publicAddress: TRUSTED_TESTNET.adminPublicAddress,
      signPreparedXdr: vi.fn(async ({ transactionXdr }) => {
        now += 1_000;
        return signedXdr(transactionXdr);
      }),
    };
    const { submitter, transport } = harness({ signer });

    await expect(submitter.registerAlert({
      ...input,
      leaseExpiresAt: new Date(now + 500),
    })).rejects.toThrow("ANCHOR_LEASE_EXPIRED");

    expect(signer.signPreparedXdr).toHaveBeenCalledOnce();
    expect(transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza timebounds vencidos tras la firma antes de llamar a sendTransaction", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
      const signer = { publicAddress: TRUSTED_TESTNET.adminPublicAddress,
        signPreparedXdr: vi.fn(async ({ transactionXdr }: { transactionXdr: string }) => {
          const result = signedXdr(transactionXdr);
          vi.setSystemTime(new Date("2026-10-26T12:00:31.000Z"));
          return result;
        }) };
      const { submitter, transport } = harness({ signer });
      await expect(submitter.registerAlert(input)).rejects.toThrow("TRANSACTION_TIMEBOUNDS_EXPIRED");
      expect(signer.signPreparedXdr).toHaveBeenCalledOnce();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("transmite una autorización explícita al firmante junto con cancelación", async () => {
    const transport = harness().transport;
    const authorizeSigning = vi.fn(async ({ transactionHash }: { transactionHash: string }) => ({
      approved: true as const, purpose: "register_alert" as const,
      transactionHash, expiresAtMs: Date.now() + 30_000,
    }));
    const signer = {
      publicAddress: TRUSTED_TESTNET.adminPublicAddress,
      signPreparedXdr: vi.fn(async ({ transactionXdr }: { transactionXdr: string }) => signedXdr(transactionXdr)),
    };
    const submitter = new StellarSdkSorobanAdminSubmitter({
      ...config, submissionEnabled: true, authorizeSigning,
    }, transport, signer);
    await expect(submitter.registerAlert(input)).resolves.toMatchObject({ status: "PENDING" });
    expect(authorizeSigning).toHaveBeenCalledOnce();
    expect(signer.signPreparedXdr).toHaveBeenCalledWith(expect.objectContaining({
      authorization: expect.objectContaining({ approved: true, purpose: "register_alert" }),
      signal,
    }));
  });

  it("no llama al firmante ni envía si la autorización del hash falta, difiere o caducó", async () => {
    for (const authorizeSigning of [
      async () => null,
      async () => ({ approved: true as const, purpose: "register_alert" as const,
        transactionHash: "0".repeat(64), expiresAtMs: Date.now() + 30_000 }),
      async ({ transactionHash }: { transactionHash: string }) => ({
        approved: true as const, purpose: "register_alert" as const,
        transactionHash, expiresAtMs: Date.now() - 1,
      }),
    ]) {
      const transport = harness().transport;
      const signer = { publicAddress: TRUSTED_TESTNET.adminPublicAddress,
        signPreparedXdr: vi.fn(async () => "would-sign") };
      const submitter = new StellarSdkSorobanAdminSubmitter({ ...config,
        submissionEnabled: true, authorizeSigning,
      }, transport, signer);
      await expect(submitter.registerAlert(input)).rejects.toThrow("AUTHORIZATION_DENIED");
      expect(signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("el plazo RPC no cubre la interacción del firmante manual", async () => {
    vi.useFakeTimers();
    try {
      const transport = harness().transport;
      let release!: (xdr: string) => void;
      const signer = { publicAddress: TRUSTED_TESTNET.adminPublicAddress,
        signPreparedXdr: vi.fn(() => new Promise<string>((resolve) => { release = resolve; })) };
      const submitter = new StellarSdkSorobanAdminSubmitter({ ...config,
        maxFeeStroops: 40_000n, feeScope: "trusted-manual-testnet",
        signerTimeoutMode: "self-managed", submissionEnabled: true,
        authorizeSigning: async ({ transactionHash }) => ({ approved: true,
          purpose: "register_alert", transactionHash, expiresAtMs: Date.now() + 30_000 }),
      }, transport, signer);
      const pending = submitter.registerAlert(input);
      await vi.advanceTimersByTimeAsync(0);
      expect(signer.signPreparedXdr).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(config.timeoutMs + 1);
      expect(transport.sendTransaction).not.toHaveBeenCalled();
      release("invalid-signed-xdr");
      await expect(pending).rejects.toThrow("SIGNATURE_REJECTED");
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("no accede a RPC ni al firmante cuando la escritura está apagada", async () => {
    const { submitter, transport, signer } = harness({ enabled: false });
    await expect(submitter.registerAlert(input)).rejects.toThrow("SUBMISSION_DISABLED");
    expect(transport.getNetwork).not.toHaveBeenCalled();
    expect(signer.signPreparedXdr).not.toHaveBeenCalled();
    expect(transport.sendTransaction).not.toHaveBeenCalled();
    const omitted = new StellarSdkSorobanAdminSubmitter(config, transport, signer);
    await expect(omitted.registerAlert(input)).rejects.toThrow("SUBMISSION_DISABLED");
    expect(transport.getNetwork).not.toHaveBeenCalled();
  });

  it("rechaza firmante ausente o administrador distinto antes de RPC", async () => {
    const transport = harness().transport;
    const absent = new StellarSdkSorobanAdminSubmitter({ ...config, submissionEnabled: true }, transport);
    await expect(absent.registerAlert(input)).rejects.toThrow("SIGNER_UNAVAILABLE");
    const wrong = harness({ signer: {
      publicAddress: "G" + "A".repeat(55), signPreparedXdr: vi.fn(),
    } });
    await expect(wrong.submitter.registerAlert(input)).rejects.toThrow("SIGNER_UNAVAILABLE");
    expect(transport.getNetwork).not.toHaveBeenCalled();
    expect(wrong.transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza cuenta origen distinta del administrador antes de simular", async () => {
    const outsider = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(0x66));
    const subject = harness({ overrides: {
      getAccount: vi.fn(async () => new Account(outsider, "1")),
    } });
    await expect(subject.submitter.registerAlert(input)).rejects.toThrow("PREFLIGHT_REJECTED");
    expect(subject.transport.simulateTransaction).not.toHaveBeenCalled();
    expect(subject.signer.signPreparedXdr).not.toHaveBeenCalled();
    expect(subject.transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza contrato, red y hashes de solicitud inválidos", async () => {
    const { submitter, transport } = harness();
    for (const change of [
      { contractId: "C" + "A".repeat(55) },
      { networkPassphrase: "other" },
      { messageKey: new Uint8Array(31) },
      { jwsHash: new Uint8Array(33) },
    ]) {
      await expect(submitter.registerAlert({ ...input, ...change })).rejects.toThrow("REQUEST_REJECTED");
    }
    expect(transport.getNetwork).not.toHaveBeenCalled();
  });

  it("rechaza deployment y dirección de administrador no confiables", () => {
    for (const change of [
      { contractId: "C" + "A".repeat(55) },
      { networkPassphrase: "other" },
      { adminPublicAddress: "G" + "A".repeat(55) },
    ]) {
      expect(() => new StellarSdkSorobanAdminSubmitter({
        ...config, deployment: { ...deployment, ...change },
      }, harness().transport)).toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    }
  });

  it("no permite ampliar ni reintentar WASM fuera del scope manual Testnet", () => {
    expect(() => new StellarSdkSorobanAdminSubmitter({
      ...config, wasmReadTimeoutMs: 20_000, wasmReadRetries: 1,
    }, harness().transport)).toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
    expect(() => new StellarSdkSorobanAdminSubmitter({
      ...config, feeScope: "trusted-manual-testnet", maxFeeStroops: 40_000n,
      wasmReadTimeoutMs: 20_001, wasmReadRetries: 1,
    }, harness().transport)).toThrow("SOROBAN_SUBMITTER_CONFIGURATION_INVALID");
  });

  it("rechaza red, WASM y origen RPC discordantes", async () => {
    for (const overrides of [
      { getNetwork: vi.fn(async () => ({ passphrase: "wrong" })) },
      { getContractWasmByContractId: vi.fn(async () => null as unknown as Uint8Array) },
      { getAccount: vi.fn(async () => new Account(StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(9)), "1")) },
    ]) {
      const { submitter, transport } = harness({ overrides });
      await expect(submitter.registerAlert(input)).rejects.toThrow("PREFLIGHT_REJECTED");
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
    digestState.value = "0".repeat(64);
    const mismatch = harness();
    await expect(mismatch.submitter.registerAlert(input)).rejects.toThrow("PREFLIGHT_REJECTED");
  });

  it("rechaza comisiones y recursos excedidos antes de firmar", async () => {
    for (const sim of [
      simulation({ minResourceFee: "5000" }),
      simulation({ transactionData: new SorobanDataBuilder().setResources(2_000_000, 100, 100).setResourceFee(100) }),
      simulation({ transactionData: new SorobanDataBuilder().setResources(10_000, 20_000, 100).setResourceFee(100) }),
      simulation({ transactionData: new SorobanDataBuilder().setResources(10_000, 100, 20_000).setResourceFee(100) }),
      simulation({ result: { auth: ["unexpected"], retval: xdr.ScVal.scvVoid() } }),
      { id: "unit", latestLedger: 1, events: [], _parsed: true, error: "failed" },
    ]) {
      const { submitter, transport, signer } = harness({ overrides: {
        simulateTransaction: vi.fn(async () => sim as never),
      } });
      await expect(submitter.registerAlert(input)).rejects.toThrow();
      expect(signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("acepta solo una autorización SOURCE_ACCOUNT para el root exacto register_alert", async () => {
    const valid = harness({ overrides: {
      simulateTransaction: vi.fn(async () => simulation({
        result: {
          auth: [registerAlertAuthorization({ messageKey: key, jwsHash: hash })],
          retval: xdr.ScVal.scvVoid(),
        },
      }) as never),
    } });
    await expect(valid.submitter.registerAlert(input)).resolves.toMatchObject({ status: "PENDING" });

    const invalidAuthorizations = [
      {
        auth: [registerAlertAuthorization({
          contractId: StrKey.encodeContract(new Uint8Array(32).fill(0x33)),
          messageKey: key, jwsHash: hash,
        })],
        code: "SIMULATION_AUTH_SCOPE_INVALID",
      },
      {
        auth: [registerAlertAuthorization({ messageKey: key, jwsHash: hash, functionName: "get_alert" })],
        code: "SIMULATION_AUTH_SCOPE_INVALID",
      },
      {
        auth: [registerAlertAuthorization({ messageKey: new Uint8Array(32).fill(9), jwsHash: hash })],
        code: "SIMULATION_AUTH_SCOPE_INVALID",
      },
      {
        auth: [registerAlertAuthorization({ messageKey: key, jwsHash: new Uint8Array(32).fill(9) })],
        code: "SIMULATION_AUTH_SCOPE_INVALID",
      },
      {
        auth: [registerAlertAuthorization({
          messageKey: key,
          jwsHash: hash,
          subInvocations: [registerAlertAuthorization({ messageKey: key, jwsHash: hash }).rootInvocation],
        })],
        code: "SIMULATION_AUTH_SCOPE_INVALID",
      },
      {
        auth: [
          registerAlertAuthorization({ messageKey: key, jwsHash: hash }),
          registerAlertAuthorization({ messageKey: key, jwsHash: hash }),
        ],
        code: "SIMULATION_AUTH_COUNT_INVALID",
      },
      { auth: [addressAuthorization("address", new Uint8Array(32).fill(7), key, hash)],
        code: "SIMULATION_AUTH_CREDENTIALS_UNSUPPORTED" },
      { auth: [addressAuthorization("addressV2", new Uint8Array(32).fill(7), key, hash)],
        code: "SIMULATION_AUTH_CREDENTIALS_UNSUPPORTED" },
      { auth: [addressAuthorization("addressWithDelegates", new Uint8Array(32).fill(7), key, hash)],
        code: "SIMULATION_AUTH_CREDENTIALS_UNSUPPORTED" },
      { auth: [{}], code: "SIMULATION_AUTH_INVALID" },
    ] as const;

    for (const sample of invalidAuthorizations) {
      const subject = harness({ overrides: {
        simulateTransaction: vi.fn(async () => simulation({
          result: { auth: sample.auth, retval: xdr.ScVal.scvVoid() },
        }) as never),
      } });
      await expect(subject.submitter.registerAlert(input)).rejects.toThrow(sample.code);
      expect(subject.signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(subject.transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("rechaza autorizaciones alteradas por el ensamblador del SDK", async () => {
    const valid = registerAlertAuthorization({ messageKey: key, jwsHash: hash });
    const changed = addressAuthorization("address", new Uint8Array(32).fill(0x77), key, hash);
    let authorizationReads = 0;
    const response = simulation({
      result: {
        get auth() {
          authorizationReads += 1;
          return authorizationReads <= 2 ? [valid] : [changed];
        },
        retval: xdr.ScVal.scvVoid(),
      },
    });
    const { submitter, transport, signer } = harness({ overrides: {
      simulateTransaction: vi.fn(async () => response as never),
    } });

    await expect(submitter.registerAlert(input)).rejects.toThrow("SIMULATION_AUTH_ASSEMBLY_CHANGED");
    expect(authorizationReads).toBeGreaterThanOrEqual(3);
    expect(signer.signPreparedXdr).not.toHaveBeenCalled();
    expect(transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("clasifica respuestas de simulación sin relajar el rechazo ni firmar", async () => {
    const cases = [
      { response: simulation({ error: "host rejected" }), code: "SIMULATION_FAILED" },
      { response: simulation({ result: { auth: [{}], retval: xdr.ScVal.scvVoid() } }), code: "SIMULATION_AUTH_INVALID" },
      { response: simulation({ minResourceFee: "invalid" }), code: "SIMULATION_FEE_INVALID" },
      { response: simulation({ minResourceFee: "5000" }), code: "SIMULATION_FEE_LIMIT_EXCEEDED" },
      { response: simulation({ restorePreamble: {} }), code: "SIMULATION_RESTORE_REQUIRED" },
    ] as const;

    for (const sample of cases) {
      const { submitter, transport, signer } = harness({ overrides: {
        simulateTransaction: vi.fn(async () => sample.response as never),
      } });
      await expect(submitter.registerAlert(input)).rejects.toThrow(sample.code);
      expect(signer.signPreparedXdr).not.toHaveBeenCalled();
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("rechaza XDR firmado con origen, operación o argumentos cambiados", async () => {
    const operations = [
      new Contract(TRUSTED_TESTNET.contractId).call("get_alert", xdr.ScVal.scvBytes(key)),
      new Contract(TRUSTED_TESTNET.contractId).call("register_alert", xdr.ScVal.scvBytes(new Uint8Array(32).fill(9)), xdr.ScVal.scvBytes(hash)),
    ];
    for (const operation of operations) {
      const { submitter, transport } = harness({ signer: {
        publicAddress: TRUSTED_TESTNET.adminPublicAddress,
        signPreparedXdr: vi.fn(async ({ transactionXdr }) => signedXdr(transactionXdr,
          (tx) => TransactionBuilder.cloneFrom(tx).clearOperations().addOperation(operation).build())),
      } });
      await expect(submitter.registerAlert(input)).rejects.toThrow("SIGNATURE_REJECTED");
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    }
    const changedSource = harness({ signer: {
      publicAddress: TRUSTED_TESTNET.adminPublicAddress,
      signPreparedXdr: vi.fn(async ({ transactionXdr }) => signedXdr(transactionXdr, (tx) =>
        new TransactionBuilder(new Account(StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(9)), "1"), {
          fee: tx.fee, networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
        }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
          xdr.ScVal.scvBytes(key), xdr.ScVal.scvBytes(hash))).setTimeout(30).build())),
    } });
    await expect(changedSource.submitter.registerAlert(input)).rejects.toThrow("SIGNATURE_REJECTED");
    expect(changedSource.transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza respuesta del firmante malformada o firma inválida", async () => {
    const bad = harness({ signer: {
      publicAddress: TRUSTED_TESTNET.adminPublicAddress, signPreparedXdr: vi.fn(async () => "bad"),
    } });
    await expect(bad.submitter.registerAlert(input)).rejects.toThrow("SIGNATURE_REJECTED");
    expect(bad.transport.sendTransaction).not.toHaveBeenCalled();
    vi.spyOn(Keypair.prototype, "verify").mockReturnValue(false);
    const invalid = harness();
    await expect(invalid.submitter.registerAlert(input)).rejects.toThrow("SIGNATURE_REJECTED");
  });

  it("distingue RPC rechazado y resultado incierto después del envío", async () => {
    const rejected = harness({ overrides: { sendTransaction: vi.fn(async (tx) => ({
      status: "ERROR" as const, hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 1, latestLedgerCloseTime: 1,
      errorResult: new xdr.TransactionResult({ feeCharged: 28_284n,
        result: xdr.TransactionResultResult.txBadSeq(), ext: xdr.TransactionResultExt.v0() }),
    })) } });
    await expect(rejected.submitter.registerAlert(input)).rejects.toMatchObject({
      code: "RPC_REJECTED", sendDiagnostic: { transactionCode: "txBadSeq",
        feeChargedStroops: "28284", latestLedger: 1 },
    });
    for (const sendTransaction of [
      vi.fn(async () => { throw new Error("no response"); }),
      vi.fn(async (tx: Transaction) => ({ status: "TRY_AGAIN_LATER" as const,
        hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 1, latestLedgerCloseTime: 1 })),
      vi.fn(async (tx: Transaction) => ({ status: "DUPLICATE" as const,
        hash: Buffer.from(tx.hash()).toString("hex"), latestLedger: 1, latestLedgerCloseTime: 1 })),
      vi.fn(async () => ({ status: "ERROR" as const, hash: "0".repeat(64), latestLedger: 1, latestLedgerCloseTime: 1 })),
      vi.fn(async () => ({ status: "PENDING" as const, hash: 42 as unknown as string, latestLedger: 1, latestLedgerCloseTime: 1 })),
    ]) {
      const uncertain = harness({ overrides: { sendTransaction: sendTransaction as never } });
      await expect(uncertain.submitter.registerAlert(input)).rejects.toThrow("SEND_RESULT_UNCERTAIN");
      expect(sendTransaction).toHaveBeenCalledOnce();
    }
  });

  it("falla cerrado ante timeout previo al envío", async () => {
    vi.useFakeTimers();
    try {
      const { submitter, transport } = harness({ overrides: {
        getNetwork: vi.fn(() => new Promise<{ readonly passphrase: string }>(() => {})),
      } });
      const pending = expect(submitter.registerAlert(input)).rejects.toThrow("RPC_TIMEOUT");
      await vi.advanceTimersByTimeAsync(config.timeoutMs + 1);
      await pending;
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("trata el timeout después de intentar enviar como resultado incierto", async () => {
    vi.useFakeTimers();
    try {
      const { submitter, transport } = harness({ overrides: {
        sendTransaction: vi.fn(() => new Promise<rpc.Api.SendTransactionResponse>(() => {})),
      } });
      const pending = expect(submitter.registerAlert(input)).rejects.toThrow("SEND_RESULT_UNCERTAIN");
      await vi.advanceTimersByTimeAsync(config.timeoutMs + 1);
      await pending;
      expect(transport.sendTransaction).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("distingue timeout del firmante antes de cualquier envío", async () => {
    vi.useFakeTimers();
    try {
      const { submitter, transport } = harness({ signer: {
        publicAddress: TRUSTED_TESTNET.adminPublicAddress,
        signPreparedXdr: vi.fn(() => new Promise<string>(() => {})),
      } });
      const pending = expect(submitter.registerAlert(input)).rejects.toThrow("SIGNER_TIMEOUT");
      await vi.advanceTimersByTimeAsync(config.timeoutMs + 1);
      await pending;
      expect(transport.sendTransaction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("mantiene el contrato del gateway: submit es PENDING y no publicación", async () => {
    const { submitter } = harness();
    const rpc = {
      getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
      getTransaction: vi.fn(),
      getAlert: vi.fn(async () => ({
        contractId: TRUSTED_TESTNET.contractId, method: "get_alert", messageKey: key, value: null,
      })),
    };
    const gateway = new SorobanTestnetAnchorGateway({
      enabled: true, submissionEnabled: true, endpointUrl: TRUSTED_TESTNET.endpointUrl,
      deployment, timeoutMs: 100,
    }, rpc, submitter);
    const result = await gateway.submit({
      deployment, messageKey: key, jwsHash: hash, attemptCount: 1,
      leaseExpiresAt: new Date(Date.now() + 30_000),
    });
    expect(result.kind).toBe("submitted");
    if (result.kind === "submitted") expect(result.receipt.transactionStatus).toBe("PENDING");
  });
});
