import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { AnchorRequest } from "../../src/modules/anchor/soroban-anchor-gateway.js";
import {
  SorobanTestnetAnchorGateway,
  type SorobanAdminTransactionSubmitter,
  type SorobanTestnetGatewayConfig,
  type SorobanTestnetRpcClient,
} from "../../src/modules/anchor/soroban-testnet-anchor-gateway.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const endpointUrl = "https://soroban-testnet.stellar.org";
const txHash = "ab".repeat(32);
const messageKey = new Uint8Array(32).fill(0x11);
const jwsHash = new Uint8Array(32).fill(0x22);
const otherHash = new Uint8Array(32).fill(0x33);
const wasmBytes = new Uint8Array([1, 2, 3]);
const deployment = {
  id: "deployment-test-1",
  network: "TESTNET" as const,
  networkPassphrase: TESTNET_PASSPHRASE,
  contractId: `C${"A".repeat(55)}`,
  wasmHash: createHash("sha256").update(wasmBytes).digest("hex"),
  adminPublicAddress: `G${"B".repeat(55)}`,
  generation: 1,
  trustedConfigVersion: "trusted-testnet-v1",
};
const request: AnchorRequest = {
  deployment,
  messageKey,
  jwsHash,
  attemptCount: 1,
  leaseExpiresAt: new Date("2026-10-25T20:00:00.000Z"),
};
const currentTime = new Date("2026-10-25T18:00:00.000Z");

function readResult(
  value: unknown,
  overrides: {
    readonly contractId?: string;
    readonly method?: string;
    readonly messageKey?: Uint8Array;
  } = {},
) {
  return {
    contractId: overrides.contractId ?? deployment.contractId,
    method: overrides.method ?? "get_alert",
    messageKey: Uint8Array.from(overrides.messageKey ?? messageKey),
    value,
  };
}

function createHarness(options: {
  readonly networkPassphrase?: string;
  readonly transaction?: unknown;
  readonly contractValue?: unknown;
  readonly contractRead?: unknown;
  readonly submitResponse?: unknown;
  readonly withSubmitter?: boolean;
  readonly submissionEnabled?: boolean;
  readonly timeoutMs?: number;
  readonly wasmReadRetries?: 0 | 1;
  readonly onWasmReadAttempt?: SorobanTestnetGatewayConfig["onWasmReadAttempt"];
  readonly submitterTimeoutMode?: "self-managed";
  readonly leaseAwareSubmitter?: true;
  readonly onPhase?: SorobanTestnetGatewayConfig["onPhase"];
  readonly onTimeout?: SorobanTestnetGatewayConfig["onTimeout"];
} = {}) {
  const rpc: SorobanTestnetRpcClient = {
    getNetwork: vi.fn(async () => ({ passphrase: options.networkPassphrase ?? TESTNET_PASSPHRASE })),
    getContractWasm: vi.fn(async () => Uint8Array.from(wasmBytes)),
    getTransaction: vi.fn(async () => options.transaction ?? { status: "NOT_FOUND" }),
    getAlert: vi.fn(async ({ contractId, messageKey: requestedKey }) =>
      options.contractRead ?? readResult(options.contractValue ?? null, {
        contractId,
        messageKey: Uint8Array.from(requestedKey),
      })),
  };
  const submitter: SorobanAdminTransactionSubmitter = {
    publicAddress: deployment.adminPublicAddress,
    registerAlert: vi.fn(async () =>
      options.submitResponse ?? { status: "PENDING", hash: txHash }),
  };
  const config: SorobanTestnetGatewayConfig = {
    enabled: true,
    ...(options.submissionEnabled !== undefined
      ? { submissionEnabled: options.submissionEnabled }
      : {}),
    endpointUrl,
    deployment,
    timeoutMs: options.timeoutMs ?? 100,
    ...(options.wasmReadRetries !== undefined ? { wasmReadRetries: options.wasmReadRetries } : {}),
    ...(options.onWasmReadAttempt ? { onWasmReadAttempt: options.onWasmReadAttempt } : {}),
    ...(options.submitterTimeoutMode ? { submitterTimeoutMode: options.submitterTimeoutMode } : {}),
    ...(options.leaseAwareSubmitter ? { leaseAwareSubmitter: true } : {}),
    ...(options.onPhase ? { onPhase: options.onPhase } : {}),
    ...(options.onTimeout ? { onTimeout: options.onTimeout } : {}),
  };
  const gateway = new SorobanTestnetAnchorGateway(
    config,
    rpc,
    options.withSubmitter === false ? undefined : submitter,
    () => new Date(currentTime),
  );
  return { gateway, rpc, submitter };
}

describe("SorobanTestnetAnchorGateway", () => {
  it("requiere habilitación explícita y solo acepta el endpoint HTTPS Testnet configurado", () => {
    expect(() => new SorobanTestnetAnchorGateway(
      { endpointUrl, deployment, timeoutMs: 100 },
      {} as SorobanTestnetRpcClient,
    )).toThrow("SOROBAN_TESTNET_GATEWAY_CONFIGURATION_INVALID");
    expect(() => new SorobanTestnetAnchorGateway(
      {
        enabled: true,
        endpointUrl: "https://stellar.org",
        deployment,
        timeoutMs: 100,
      },
      {} as SorobanTestnetRpcClient,
    )).toThrow("SOROBAN_TESTNET_GATEWAY_CONFIGURATION_INVALID");
    expect(() => new SorobanTestnetAnchorGateway(
      {
        enabled: true,
        endpointUrl,
        deployment: { ...deployment, networkPassphrase: "Public Global Stellar Network ; September 2015" },
        timeoutMs: 100,
      },
      {} as SorobanTestnetRpcClient,
    )).toThrow("SOROBAN_TESTNET_GATEWAY_CONFIGURATION_INVALID");
  });

  it("verifica la identidad Testnet y consulta get_alert en el contrato configurado", async () => {
    const { gateway, rpc } = createHarness();
    const result = await gateway.reconcile(request, null);

    expect(result).toMatchObject({
      kind: "absent",
      deploymentId: deployment.id,
      contractId: deployment.contractId,
      priorTransactionStatus: "NOT_APPLICABLE",
    });
    expect(rpc.getNetwork).toHaveBeenCalledWith(expect.objectContaining({ endpointUrl }));
    expect(rpc.getAlert).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: deployment.contractId,
      messageKey,
    }));
    expect(rpc.getContractWasm).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl,
      contractId: deployment.contractId,
    }));
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });

  it("rechaza identidad de red incorrecta sin leer el contrato ni consultar transacciones", async () => {
    const { gateway, rpc } = createHarness({
      networkPassphrase: "Public Global Stellar Network ; September 2015",
    });
    await expect(gateway.reconcile(request, null)).resolves.toEqual({
      kind: "unknown",
      code: "RPC_UNAVAILABLE",
    });
    expect(rpc.getAlert).not.toHaveBeenCalled();
    expect(rpc.getContractWasm).not.toHaveBeenCalled();
    expect(rpc.getTransaction).not.toHaveBeenCalled();
  });

  it("rechaza deployment o contrato distintos al trust config antes de RPC", async () => {
    const { gateway, rpc } = createHarness();
    await expect(gateway.reconcile({
      ...request,
      deployment: { ...deployment, contractId: `C${"Z".repeat(55)}` },
    }, null)).resolves.toEqual({ kind: "unknown", code: "RESULT_UNCERTAIN" });
    expect(rpc.getNetwork).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FOUND", { status: "NOT_FOUND" }],
    ["PENDING", { status: "PENDING" }],
  ])("trata una transacción previa %s y una lectura vacía como inciertas", async (_name, transaction) => {
    const { gateway } = createHarness({ transaction });
    await expect(gateway.reconcile(request, txHash)).resolves.toEqual({
      kind: "unknown",
      code: "RESULT_UNCERTAIN",
    });
  });

  it("confirma con SUCCESS y relectura coincidente del hash desde el contrato confiable", async () => {
    const { gateway, rpc } = createHarness({
      transaction: { status: "SUCCESS", txHash, ledger: 91_234 },
      contractValue: jwsHash,
    });
    const result = await gateway.reconcile(request, txHash);

    expect(result).toMatchObject({
      kind: "confirmed",
      evidence: {
        source: "transaction_and_readback",
        deploymentId: deployment.id,
        contractId: deployment.contractId,
        txHash,
        confirmedLedger: 91_234n,
        transactionStatus: "SUCCESS",
        contractReadMatched: true,
      },
    });
    if (result.kind === "confirmed") {
      expect(Buffer.from(result.evidence.messageKey)).toEqual(Buffer.from(messageKey));
      expect(Buffer.from(result.evidence.jwsHash)).toEqual(Buffer.from(jwsHash));
    }
    expect(rpc.getTransaction).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl,
      transactionHash: txHash,
    }));
  });

  it.each([
    ["PENDING", { status: "PENDING" }, null],
    ["NOT_FOUND", { status: "NOT_FOUND" }, null],
    ["ERROR", { status: "ERROR" }, null],
    ["SUCCESS sin lectura", { status: "SUCCESS", txHash, ledger: 91_234 }, null],
    ["SUCCESS con hash distinto", { status: "SUCCESS", txHash, ledger: 91_234 }, otherHash],
  ])("nunca confirma %s sin get_alert coincidente", async (_label, transaction, contractValue) => {
    const { gateway } = createHarness({ transaction, contractValue });
    const result = await gateway.reconcile(request, txHash);
    expect(result.kind).not.toBe("confirmed");
    if (contractValue === otherHash) expect(result.kind).toBe("conflict");
  });

  it("no confirma una lectura coincidente sin estado SUCCESS de la transacción", async () => {
    const { gateway } = createHarness({
      transaction: { status: "NOT_FOUND" },
      contractValue: jwsHash,
    });
    const result = await gateway.reconcile(request, txHash);

    expect(result).toMatchObject({
      kind: "matching_read",
      deploymentId: deployment.id,
      contractId: deployment.contractId,
      observedContractHash: jwsHash,
    });
  });

  it("no considera FAILED suficiente sin comprobar antes la ausencia del registro", async () => {
    const { gateway } = createHarness({
      transaction: { status: "FAILED", txHash },
      contractValue: null,
    });
    await expect(gateway.reconcile(request, txHash)).resolves.toMatchObject({
      kind: "absent",
      priorTransactionStatus: "FAILED",
      observedContractHash: null,
    });
  });

  it("trata contrato con hash diferente como conflicto y no como confirmado", async () => {
    const { gateway } = createHarness({ contractValue: otherHash });
    const result = await gateway.reconcile(request, null);

    expect(result).toMatchObject({
      kind: "conflict",
      deploymentId: deployment.id,
      contractId: deployment.contractId,
    });
    if (result.kind === "conflict") {
      expect(Buffer.from(result.observedContractHash)).toEqual(Buffer.from(otherHash));
    }
  });

  it("rechaza una lectura asociada a otra messageKey, contrato o método", async () => {
    for (const contractRead of [
      readResult(jwsHash, { messageKey: new Uint8Array(32).fill(0x44) }),
      readResult(jwsHash, { contractId: `C${"C".repeat(55)}` }),
      readResult(jwsHash, { method: "verify_hash" }),
    ]) {
      const { gateway } = createHarness({ contractRead });
      await expect(gateway.reconcile(request, null)).resolves.toEqual({
        kind: "unknown",
        code: "RESULT_UNCERTAIN",
      });
    }
  });

  it("no confirma respuestas XDR/valores ambiguos ni transacciones SUCCESS sin ledger válido", async () => {
    const malformedRead = createHarness({ contractValue: "0x" + "22".repeat(32) });
    await expect(malformedRead.gateway.reconcile(request, null)).resolves.toEqual({
      kind: "unknown",
      code: "RESULT_UNCERTAIN",
    });

    const malformedTransaction = createHarness({
      transaction: { status: "SUCCESS", txHash, ledger: "not-a-ledger" },
      contractValue: null,
    });
    await expect(malformedTransaction.gateway.reconcile(request, txHash)).resolves.toEqual({
      kind: "unknown",
      code: "RESULT_UNCERTAIN",
    });

    const malformedDespiteMatchingRead = createHarness({
      transaction: { status: "SUCCESS", txHash, ledger: "not-a-ledger" },
      contractValue: jwsHash,
    });
    await expect(malformedDespiteMatchingRead.gateway.reconcile(request, txHash)).resolves.toEqual({
      kind: "unknown",
      code: "RESULT_UNCERTAIN",
    });
    expect(malformedDespiteMatchingRead.rpc.getAlert).not.toHaveBeenCalled();

    const successWithoutReadback = createHarness({
      transaction: { status: "SUCCESS", txHash, ledger: 91_235 },
      contractValue: null,
    });
    await expect(successWithoutReadback.gateway.reconcile(request, txHash)).resolves.toEqual({
      kind: "unknown",
      code: "RESULT_UNCERTAIN",
    });

    const mismatchedTransaction = createHarness({
      transaction: { status: "SUCCESS", txHash: "ff".repeat(32), ledger: 91_235 },
      contractValue: null,
    });
    await expect(mismatchedTransaction.gateway.reconcile(request, txHash)).resolves.toEqual({
      kind: "unknown",
      code: "RESULT_UNCERTAIN",
    });
  });

  it("normaliza errores de transporte y timeout sin propagar detalles del RPC", async () => {
    const transport = createHarness();
    vi.mocked(transport.rpc.getNetwork).mockRejectedValueOnce(
      new Error("sensitive transport detail"),
    );
    await expect(transport.gateway.reconcile(request, null)).resolves.toEqual({
      kind: "unknown",
      code: "RPC_UNAVAILABLE",
    });

    const timeout = createHarness({ timeoutMs: 5 });
    vi.mocked(timeout.rpc.getNetwork).mockImplementationOnce(() => new Promise(() => {}));
    await expect(timeout.gateway.reconcile(request, null)).resolves.toEqual({
      kind: "unknown",
      code: "RPC_UNAVAILABLE",
    });
  });

  it("da plazos independientes a NETWORK y WASM secuenciales", async () => {
    vi.useFakeTimers();
    try {
      const phases: string[] = [];
      const { gateway, rpc } = createHarness({
        timeoutMs: 1_000,
        onPhase: (phase) => phases.push(phase),
      });
      vi.mocked(rpc.getNetwork).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        return { passphrase: TESTNET_PASSPHRASE };
      });
      vi.mocked(rpc.getContractWasm!).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 900));
        return Uint8Array.from(wasmBytes);
      });

      const pending = gateway.reconcile(request, null);
      await vi.advanceTimersByTimeAsync(1_800);
      await expect(pending).resolves.toMatchObject({ kind: "absent" });
      expect(phases).toEqual(["NETWORK", "WASM", "CONTRACT_READ"]);
      expect(rpc.getAlert).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("acepta WASM antes de su deadline de 20 segundos y registra la duración saneada", async () => {
    vi.useFakeTimers();
    try {
      const attempts: Array<[number, number, string | null]> = [];
      const { gateway, rpc } = createHarness({
        timeoutMs: 20_000,
        wasmReadRetries: 1,
        onWasmReadAttempt: (attempt, duration, code) => attempts.push([attempt, duration, code]),
      });
      vi.mocked(rpc.getContractWasm!).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 19_999));
        return Uint8Array.from(wasmBytes);
      });
      const pending = gateway.reconcile(request, null);
      await vi.advanceTimersByTimeAsync(19_999);
      await expect(pending).resolves.toMatchObject({ kind: "absent" });
      expect(attempts).toEqual([[1, 19_999, null]]);
      expect(rpc.getContractWasm).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reintenta una sola lectura WASM tras timeout y nunca reintenta una discrepancia", async () => {
    vi.useFakeTimers();
    try {
      const attempts: Array<[number, number, string | null]> = [];
      const { gateway, rpc } = createHarness({
        timeoutMs: 20_000,
        wasmReadRetries: 1,
        onWasmReadAttempt: (attempt, duration, code) => attempts.push([attempt, duration, code]),
      });
      vi.mocked(rpc.getContractWasm!).mockImplementationOnce(() =>
        new Promise((resolve) => setTimeout(() => resolve(Uint8Array.from(wasmBytes)), 20_001)));
      const pending = gateway.reconcile(request, null);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toMatchObject({ kind: "absent" });
      expect(rpc.getContractWasm).toHaveBeenCalledTimes(2);
      expect(attempts).toEqual([
        [1, 20_000, "WASM_RPC_TIMEOUT"],
        [2, 0, null],
      ]);
      expect(rpc.getAlert).toHaveBeenCalledOnce();

      const discrepant = createHarness({
        timeoutMs: 20_000,
        wasmReadRetries: 1,
      });
      vi.mocked(discrepant.rpc.getContractWasm!).mockResolvedValueOnce(
        new Uint8Array([9, 9, 9]),
      );
      await expect(discrepant.gateway.reconcile(request, null)).resolves.toEqual({
        kind: "unknown", code: "RPC_UNAVAILABLE",
      });
      expect(discrepant.rpc.getContractWasm).toHaveBeenCalledOnce();
      expect(discrepant.rpc.getAlert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clasifica timeout WASM precisamente y no continúa a la lectura contractual", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: string[] = [];
      const { gateway, rpc } = createHarness({
        timeoutMs: 1_000,
        onTimeout: (phase) => timeouts.push(phase),
      });
      vi.mocked(rpc.getContractWasm!).mockImplementationOnce(() =>
        new Promise((resolve) => setTimeout(() => resolve(Uint8Array.from(wasmBytes)), 1_001)));

      const pending = gateway.reconcile(request, null);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toEqual({ kind: "unknown", code: "RPC_UNAVAILABLE" });
      expect(timeouts).toEqual(["WASM"]);
      expect(rpc.getAlert).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(rpc.getAlert).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("permite dos RPC secuenciales dentro de CONTRACT_READ y nunca infiere ausencia por timeout", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: string[] = [];
      const { gateway, rpc } = createHarness({
        timeoutMs: 1_000,
        onTimeout: (phase) => timeouts.push(phase),
      });
      vi.mocked(rpc.getAlert).mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 1_800));
        return readResult(null);
      });
      const slowRead = gateway.reconcile(request, null);
      await vi.advanceTimersByTimeAsync(1_800);
      await expect(slowRead).resolves.toMatchObject({ kind: "absent" });
      expect(timeouts).toEqual([]);

      vi.mocked(rpc.getAlert).mockImplementationOnce(() => new Promise(() => {}));
      const timedOutRead = gateway.reconcile(request, null);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(timedOutRead).resolves.toEqual({
        kind: "unknown",
        code: "RPC_UNAVAILABLE",
      });
      expect(timeouts).toEqual(["CONTRACT_READ"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bloquea el envío sin firmante autorizado y ante dirección admin distinta", async () => {
    const noSigner = createHarness({
      withSubmitter: false,
      submissionEnabled: true,
    });
    await expect(noSigner.gateway.submit(request)).rejects.toThrow("SOROBAN_SUBMISSION_DISABLED");
    expect(noSigner.rpc.getNetwork).not.toHaveBeenCalled();

    const mismatchedAdmin = createHarness({ submissionEnabled: true });
    const submitter = mismatchedAdmin.submitter as {
      publicAddress: string;
      registerAlert: SorobanAdminTransactionSubmitter["registerAlert"];
    };
    submitter.publicAddress = `G${"D".repeat(55)}`;
    await expect(mismatchedAdmin.gateway.submit(request)).rejects.toThrow(
      "SOROBAN_ADMIN_AUTHORITY_MISMATCH",
    );
    expect(mismatchedAdmin.submitter.registerAlert).not.toHaveBeenCalled();
  });

  it("mantiene el envío deshabilitado cuando no existe opt-in explícito", async () => {
    const { gateway, rpc, submitter } = createHarness({ submissionEnabled: false });
    await expect(gateway.submit(request)).rejects.toThrow("SOROBAN_SUBMISSION_DISABLED");
    expect(rpc.getNetwork).not.toHaveBeenCalled();
    expect(submitter.registerAlert).not.toHaveBeenCalled();
  });

  it("requiere relectura vacía antes de enviar y devuelve solo estado PENDING", async () => {
    const { gateway, rpc, submitter } = createHarness({
      submissionEnabled: true,
      leaseAwareSubmitter: true,
    });
    const result = await gateway.submit(request);

    expect(result).toMatchObject({
      kind: "submitted",
      receipt: {
        deploymentId: deployment.id,
        contractId: deployment.contractId,
        txHash,
        transactionStatus: "PENDING",
      },
    });
    expect(rpc.getAlert).toHaveBeenCalledTimes(1);
    expect(submitter.registerAlert).toHaveBeenCalledWith(expect.objectContaining({
      endpointUrl,
      networkPassphrase: TESTNET_PASSPHRASE,
      contractId: deployment.contractId,
      messageKey,
      jwsHash,
      leaseExpiresAt: request.leaseExpiresAt,
    }));
  });

  it("el modo interactivo no aplica el plazo RPC global al callback del submitter", async () => {
    vi.useFakeTimers();
    try {
      const { gateway, submitter } = createHarness({ submissionEnabled: true,
        timeoutMs: 10, submitterTimeoutMode: "self-managed" });
      let complete!: (value: unknown) => void;
      vi.mocked(submitter.registerAlert).mockImplementationOnce(() => new Promise((resolve) => {
        complete = resolve;
      }));
      const result = gateway.submit(request);
      await vi.advanceTimersByTimeAsync(11);
      expect(submitter.registerAlert).toHaveBeenCalledOnce();
      complete({ status: "PENDING", hash: txHash });
      await expect(result).resolves.toMatchObject({ kind: "submitted" });
    } finally { vi.useRealTimers(); }
  });

  it("bloquea envío si ya existe una entrada o la lease expiró", async () => {
    const existing = createHarness({ submissionEnabled: true, contractValue: jwsHash });
    await expect(existing.gateway.submit(request)).rejects.toThrow(
      "SOROBAN_RECONCILIATION_REQUIRED",
    );
    expect(existing.submitter.registerAlert).not.toHaveBeenCalled();

    const expired = createHarness({ submissionEnabled: true });
    await expect(expired.gateway.submit({
      ...request,
      leaseExpiresAt: new Date(currentTime.getTime() - 1),
    })).rejects.toThrow("SOROBAN_LEASE_EXPIRED");
    expect(expired.submitter.registerAlert).not.toHaveBeenCalled();
  });

  it("no trata un timeout del envío como rechazo definitivo y no interpreta respuesta inválida como éxito", async () => {
    const { gateway, submitter } = createHarness({ submissionEnabled: true });
    vi.mocked(submitter.registerAlert).mockRejectedValueOnce(
      new Error("transport ended after possible acceptance"),
    );
    await expect(gateway.submit(request)).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(submitter.registerAlert).toHaveBeenCalledOnce();

    const invalidReceipt = createHarness({
      submissionEnabled: true,
      submitResponse: { status: "SUCCESS", hash: txHash },
    });
    await expect(invalidReceipt.gateway.submit(request)).rejects.toThrow(
      "SOROBAN_SUBMISSION_RESPONSE_INVALID",
    );

    const preflightFailure = createHarness({ submissionEnabled: true });
    vi.mocked(preflightFailure.rpc.getNetwork).mockRejectedValueOnce(
      new Error("sensitive RPC response"),
    );
    await expect(preflightFailure.gateway.submit(request)).rejects.toThrow(
      "SOROBAN_SUBMISSION_PREFLIGHT_FAILED",
    );
  });

  it("preserva el código de discrepancia WASM en un fallo de preflight de envío", async () => {
    const mismatch = createHarness({ submissionEnabled: true });
    vi.mocked(mismatch.rpc.getContractWasm!).mockResolvedValueOnce(
      Uint8Array.from([...wasmBytes, 4]),
    );
    await expect(mismatch.gateway.submit(request)).rejects.toMatchObject({
      phase: "PREFLIGHT",
      code: "SOROBAN_WASM_IDENTITY_MISMATCH",
    });
    expect(mismatch.submitter.registerAlert).not.toHaveBeenCalled();
  });
});
