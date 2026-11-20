import { createHash } from "node:crypto";
import { Account, Contract, Keypair, SorobanDataBuilder, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createManualLabJws, inspectPreparedManualAnchor, main, parseManualTestnetFeeBudget, runManualOneAnchor,
  runReadonlyDiagnosis, runReadonlyReconciliation, validateManualLabJws,
  type ManualLabJws, type PreparedAnchorIntent,
} from "../../scripts/manual-soroban-testnet-anchor.js";
import { calculateJwsHash, calculateMessageKey } from "../../src/modules/signing/alert-hashes.js";
import type { SorobanSubmitRpc } from "../../src/modules/anchor/stellar-sdk-admin-submitter.js";
import { NodeStellarCliProcessRunner, type StellarCliProcessRunner } from "../../src/modules/anchor/stellar-cli-secure-store-signer.js";
import type { StellarRpcServer, StellarRpcServerFactory } from "../../src/modules/anchor/stellar-sdk-soroban-rpc-client.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import { registerAlertAuthorization } from "./soroban-auth-fixtures.js";

const digestState = vi.hoisted(() => ({ value: "90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f" }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    createHash: (...args: Parameters<typeof actual.createHash>) => {
      const hash = actual.createHash(...args);
      const update = hash.update.bind(hash);
      const digest = hash.digest.bind(hash);
      let isWasmFixture = false;
      hash.update = ((data: string | Uint8Array, inputEncoding?: BufferEncoding) => {
        isWasmFixture = typeof data !== "string" &&
          Buffer.from(data).equals(Buffer.from([0, 97, 115, 109]));
        if (typeof data === "string") update(data, inputEncoding ?? "utf8");
        else update(data);
        return hash;
      }) as typeof hash.update;
      hash.digest = ((encoding?: Parameters<typeof digest>[0]) =>
        isWasmFixture ? digestState.value : encoding ? digest(encoding) : digest()) as typeof hash.digest;
      return hash;
    },
  };
});

let labEvidence: ManualLabJws;
let KEY: Uint8Array;
let HASH: Uint8Array;
const realSetImmediate = setImmediate;

function signedXdr(unsignedXdr: string, wrongSignature = false): string {
  const tx = new Transaction(unsignedXdr, TRUSTED_TESTNET.networkPassphrase);
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("fixture invalid");
  return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
    tx: envelope.value.tx,
    signatures: [new xdr.DecoratedSignature({
      hint: Keypair.fromPublicKey(TRUSTED_TESTNET.adminPublicAddress).signatureHint(),
      signature: new Uint8Array(64).fill(wrongSignature ? 0x99 : 0x55),
    })],
  })).toXdr("base64");
}

function fixture(options: {
  readonly approved?: boolean;
  readonly sendStatus?: "PENDING" | "ERROR" | "DUPLICATE" | "TRY_AGAIN_LATER";
  readonly sendErrorResult?: xdr.TransactionResult;
  readonly transactionStatus?: "SUCCESS" | "FAILED" | "NOT_FOUND";
  readonly recordAfterSend?: Uint8Array | null;
  readonly existingRecord?: Uint8Array | null;
  readonly fee?: string;
  readonly resourceFee?: number;
  readonly hangSend?: boolean;
  readonly wrongSignature?: boolean;
} = {}) {
  const state: {
    stored: Uint8Array | null;
    transactionStatus: "SUCCESS" | "FAILED" | "NOT_FOUND";
  } = {
    stored: options.existingRecord ?? null,
    transactionStatus: options.transactionStatus ?? "NOT_FOUND",
  };
  const server: StellarRpcServer = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getContractWasmByContractId: vi.fn(async () => Uint8Array.from([0, 97, 115, 109])),
    getAccount: vi.fn(async () => new Account(TRUSTED_TESTNET.adminPublicAddress, "1")),
    getTransaction: vi.fn(async (hash) => ({
      status: state.transactionStatus, txHash: hash,
      ...(state.transactionStatus === "SUCCESS" ? { ledger: 123 } : {}),
    })),
    simulateTransaction: vi.fn(async () => ({
      result: { retval: state.stored === null
        ? xdr.ScVal.scvVoid() : xdr.ScVal.scvBytes(state.stored) },
    })),
  };
  const readServerFactory: StellarRpcServerFactory = vi.fn(() => server);
  const submitTransport: SorobanSubmitRpc = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getContractWasmByContractId: vi.fn(async () => Uint8Array.from([0, 97, 115, 109])),
    getAccount: vi.fn(async () => new Account(TRUSTED_TESTNET.adminPublicAddress, "1")),
    simulateTransaction: vi.fn(async () => ({
      id: "offline", latestLedger: 1, events: [], _parsed: true,
      transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100)
        .setResourceFee(options.resourceFee ?? 100),
      minResourceFee: options.fee ?? "100",
      result: {
        auth: [registerAlertAuthorization({ messageKey: KEY, jwsHash: HASH })],
        retval: xdr.ScVal.scvVoid(),
      },
    })),
    sendTransaction: vi.fn(async (tx) => {
      if (options.hangSend) return new Promise<never>(() => {});
      if (options.recordAfterSend !== undefined) state.stored = options.recordAfterSend;
      return {
        status: options.sendStatus ?? "PENDING",
        hash: Buffer.from(tx.hash()).toString("hex"),
        latestLedger: 1, latestLedgerCloseTime: 1,
        ...(options.sendErrorResult ? { errorResult: options.sendErrorResult } : {}),
      };
    }) as SorobanSubmitRpc["sendTransaction"],
  };
  const processRunner: StellarCliProcessRunner = {
    run: vi.fn(async ({ stdin }) => ({
      exitCode: 0, stdout: signedXdr(stdin.replace(/\r?\n$/u, ""), options.wrongSignature),
    })),
  };
  const output = vi.fn();
  const approveTransaction = vi.fn(async (_intent: PreparedAnchorIntent) => options.approved !== false);
  const deps = {
    readServerFactory, submitTransport, processRunner, output, approveTransaction,
    createLabJws: async () => labEvidence,
  };
  return { state, server, submitTransport, processRunner, output, approveTransaction, deps };
}

function diagnosisDeps(f: ReturnType<typeof fixture>) {
  const { getNetwork, getContractWasmByContractId, getAccount, simulateTransaction } = f.submitTransport;
  return {
    readServerFactory: f.deps.readServerFactory,
    preparationTransport: Object.freeze({ getNetwork, getContractWasmByContractId, getAccount, simulateTransaction }),
    createLabJws: f.deps.createLabJws,
    output: f.output,
  };
}

beforeEach(() => {
  digestState.value = TRUSTED_TESTNET.wasmHash;
  vi.spyOn(Keypair.prototype, "verify").mockReturnValue(true);
});
beforeAll(async () => {
  labEvidence = await createManualLabJws();
  KEY = Uint8Array.from(calculateMessageKey(labEvidence.identity));
  HASH = Uint8Array.from(calculateJwsHash(labEvidence.compact));
});
afterEach(() => vi.restoreAllMocks());

describe("runner manual M5 con dobles locales", () => {
  it("confirma solo después de PENDING, SUCCESS y get_alert coincidente", async () => {
    const f = fixture({ transactionStatus: "SUCCESS", recordAfterSend: HASH });
    const result = await runManualOneAnchor(f.deps);
    expect(result.state).toBe("CONFIRMED");
    expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
    expect(f.processRunner.run).toHaveBeenCalledOnce();
    expect(f.approveTransaction).toHaveBeenCalledOnce();
    const intent = f.approveTransaction.mock.calls[0]?.[0];
    expect(intent).toMatchObject({
      source: TRUSTED_TESTNET.adminPublicAddress,
      contractId: TRUSTED_TESTNET.contractId,
      method: "register_alert", messageKeyHex: Buffer.from(KEY).toString("hex"),
      jwsHashHex: Buffer.from(HASH).toString("hex"),
      maxFeeStroops: "40000",
    });
    expect(intent?.transactionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(Number(intent?.maxTime)).toBeGreaterThan(Math.floor(Date.now() / 1_000));
    expect(f.output).toHaveBeenCalledWith(expect.stringContaining("PENDING"));
    expect(f.output).toHaveBeenCalledWith(expect.stringContaining("SUCCESS + get_alert coincidente"));
    const printed = f.output.mock.calls.map(([line]) => line).join("\n");
    expect(printed).toContain("no emitido por el firmador productivo M3");
    expect(printed).toContain(`JWS compacto: ${labEvidence.compact}`);
    expect(printed).toContain("message_key canonico:");
    expect(printed).toContain("jws_hash SHA-256(ASCII(JWS compacto)):");
  });

  it("genera y verifica JWS ES256 de laboratorio y deriva ambos hashes canónicos", async () => {
    const evidence = await createManualLabJws();
    const verified = await validateManualLabJws(evidence);
    const expectedJwsHash = createHash("sha256").update(evidence.compact, "ascii").digest();
    const expectedMessageKey = createHash("sha256")
      .update(`SIGA-E-ALERT-ID-v1\n${evidence.identity.sender}\n${evidence.identity.identifier}\n${evidence.identity.sent}`, "utf8")
      .digest();

    expect(evidence.compact.split(".")).toHaveLength(3);
    expect(verified.jwsHash).toHaveLength(32);
    expect(verified.messageKey).toHaveLength(32);
    expect(Buffer.from(verified.jwsHash)).toEqual(expectedJwsHash);
    expect(Buffer.from(verified.messageKey)).toEqual(expectedMessageKey);
    expect(verified.messageKey).toEqual(calculateMessageKey(evidence.identity));
    expect(verified.jwsHash).toEqual(calculateJwsHash(evidence.compact));
    expect(evidence.kid).toMatch(/^manual-lab-/u);
    expect(evidence.publicKey.type).toBe("public");
  });

  it("rechaza JWS manipulado y algoritmos distintos de ES256", async () => {
    const [protectedSegment, payloadSegment, signatureSegment] = labEvidence.compact.split(".");
    const alteredPayload = Buffer.from(JSON.stringify({
      sender: labEvidence.identity.sender,
      identifier: labEvidence.identity.identifier,
      sent: labEvidence.identity.sent,
      status: "Exercise", scope: "Public", msgType: "Alert",
      info: [{ severity: "Severe", headline: "SIMULACRO alterado" }],
    }), "ascii").toString("base64url");
    await expect(validateManualLabJws({
      ...labEvidence, compact: `${protectedSegment}.${alteredPayload}.${signatureSegment}`,
    })).rejects.toThrow();

    const forbiddenHeader = Buffer.from(JSON.stringify({ alg: "HS256", kid: labEvidence.kid }))
      .toString("base64url");
    await expect(validateManualLabJws({
      ...labEvidence, compact: `${forbiddenHeader}.${payloadSegment}.${signatureSegment}`,
    })).rejects.toThrow("alg=ES256");
  });

  it("rechaza evidencia JWS invalida antes de cualquier lectura RPC, firma o envio", async () => {
    const f = fixture();
    const [protectedSegment, payloadSegment, signatureSegment] = labEvidence.compact.split(".");
    const invalidEvidence = {
      ...labEvidence,
      compact: `${protectedSegment}.${payloadSegment}.${Buffer.alloc(64, 0).toString("base64url")}`,
    };
    await expect(runManualOneAnchor({
      ...f.deps, createLabJws: async () => invalidEvidence,
    })).rejects.toThrow();
    expect(f.server.getNetwork).not.toHaveBeenCalled();
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza autorización faltante sin firmar ni enviar", async () => {
    const f = fixture({ approved: false });
    const result = await runManualOneAnchor(f.deps);
    expect(result.state).toBe("BLOCKED");
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("la segunda aprobación puede esperar más que el plazo RPC sin firma ni envío", async () => {
    const realSetTimeout = setTimeout;
    const realClearTimeout = clearTimeout;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });

    try {
      const f = fixture();

      let release!: (approved: boolean) => void;
      let signalApproval!: () => void;

      const approvalReached = new Promise<void>((resolve) => {
        signalApproval = resolve;
      });

      const approveTransaction = vi.fn(() => {
        const decision = new Promise<boolean>((resolve) => {
          release = resolve;
        });

        signalApproval();

        return decision;
      });

      const pending = runManualOneAnchor({
        ...f.deps,
        approveTransaction,
      });

      let guardTimer: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          approvalReached,

          pending.then(() => {
            throw new Error(
              "M5_APPROVAL_FLOW_FINISHED_BEFORE_CALLBACK",
            );
          }),

          new Promise<never>((_, reject) => {
            guardTimer = realSetTimeout(() => {
              reject(new Error("M5_APPROVAL_CALLBACK_TIMEOUT"));
            }, 3_000);
          }),
        ]);
      } finally {
        if (guardTimer !== undefined) {
          realClearTimeout(guardTimer);
        }
      }

      expect(approveTransaction).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10_001);

      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();

      release(false);

      await expect(pending).resolves.toMatchObject({
        state: "BLOCKED",
        phase: "AUTHORIZATION",
        code: "AUTHORIZATION_DENIED",
        detail: "OPERATOR_APPROVAL_DENIED",
        sendAttempted: false,
      });

      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechaza firma inválida antes de transporte RPC de envío", async () => {
    vi.spyOn(Keypair.prototype, "verify").mockReturnValue(false);
    const f = fixture({ wrongSignature: true });
    const result = await runManualOneAnchor(f.deps);
    expect(result).toMatchObject({ state: "BLOCKED", phase: "SIGNING", code: "SIGNING_FAILED", sendAttempted: false });
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("detiene preflight ante WASM distinto o message_key ya registrado", async () => {
    digestState.value = "0".repeat(64);
    const wasm = fixture();
    expect(await runManualOneAnchor(wasm.deps)).toMatchObject({
      state: "BLOCKED", phase: "WASM", code: "PREFLIGHT_FAILED",
      detail: "WASM_IDENTITY_MISMATCH", sendAttempted: false,
    });
    expect(wasm.processRunner.run).not.toHaveBeenCalled();
    digestState.value = TRUSTED_TESTNET.wasmHash;
    const existing = fixture({ existingRecord: HASH });
    expect(await runManualOneAnchor(existing.deps)).toMatchObject({
      state: "BLOCKED", phase: "CONTRACT_READ", code: "PREFLIGHT_FAILED", sendAttempted: false,
    });
    expect(existing.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("reintenta solo lectura WASM una vez y luego bloquea sin autorizar, firmar ni enviar", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const f = fixture();
      vi.mocked(f.server.getContractWasmByContractId!).mockImplementation(() =>
        new Promise((resolve) => setTimeout(() => resolve(Uint8Array.from([0, 97, 115, 109])), 20_001)));

      const pending = runManualOneAnchor(f.deps);
      for (let attempt = 0; attempt < 100 &&
          !vi.mocked(f.server.getContractWasmByContractId!).mock.calls.length; attempt += 1) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(f.server.getContractWasmByContractId!).toHaveBeenCalledOnce();
      expect(f.deps.readServerFactory).toHaveBeenCalledWith(
        TRUSTED_TESTNET.endpointUrl, 20_000,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      for (let attempt = 0; attempt < 100 &&
          vi.mocked(f.server.getContractWasmByContractId!).mock.calls.length < 2; attempt += 1) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(f.server.getContractWasmByContractId!).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toMatchObject({
        state: "BLOCKED",
        phase: "WASM",
        code: "PREFLIGHT_FAILED",
        detail: "WASM_RPC_TIMEOUT",
        sendAttempted: false,
      });
      expect(f.approveTransaction).not.toHaveBeenCalled();
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
      expect(f.output).toHaveBeenCalledWith(
        "RPC fase=WASM intento=1 duración=20000ms código=WASM_RPC_TIMEOUT",
      );
      expect(f.output).toHaveBeenCalledWith(
        "RPC fase=WASM intento=2 duración=20000ms código=WASM_RPC_TIMEOUT",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("consume como máximo un reintento WASM en todo el preflight del runner", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const f = fixture();
      vi.mocked(f.server.getContractWasmByContractId!)
        .mockImplementationOnce(() =>
          new Promise((resolve) => setTimeout(() => resolve(Uint8Array.from([0, 97, 115, 109])), 20_001)))
        .mockImplementationOnce(async () => Uint8Array.from([0, 97, 115, 109]))
        .mockImplementationOnce(() =>
          new Promise((resolve) => setTimeout(() => resolve(Uint8Array.from([0, 97, 115, 109])), 20_001)));

      const pending = runManualOneAnchor(f.deps);
      for (let attempt = 0; attempt < 100 &&
          !vi.mocked(f.server.getContractWasmByContractId!).mock.calls.length; attempt += 1) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      await vi.advanceTimersByTimeAsync(20_000);
      for (let attempt = 0; attempt < 100 &&
          vi.mocked(f.server.getContractWasmByContractId!).mock.calls.length < 3; attempt += 1) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(f.server.getContractWasmByContractId!).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(pending).resolves.toMatchObject({
        state: "BLOCKED", phase: "WASM", code: "PREFLIGHT_FAILED", sendAttempted: false,
      });
      expect(f.server.getContractWasmByContractId!).toHaveBeenCalledTimes(3);
      expect(f.approveTransaction).not.toHaveBeenCalled();
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bloquea comisión simulada excesiva antes de firmar", async () => {
    const f = fixture({ fee: "39901" });
    const result = await runManualOneAnchor(f.deps);
    expect(result).toMatchObject({ state: "BLOCKED", phase: "SIMULATION", code: "PREPARATION_FAILED", sendAttempted: false });
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("distingue rechazo RPC y mantiene un único intento", async () => {
    const errorResult = new xdr.TransactionResult({ feeCharged: 28_284n,
      result: xdr.TransactionResultResult.txBadAuth(), ext: xdr.TransactionResultExt.v0() });
    const f = fixture({ sendStatus: "ERROR", sendErrorResult: errorResult });
    const result = await runManualOneAnchor(f.deps);
    expect(result.state).toBe("REJECTED");
    if (result.state === "CONFIRMED") throw new Error();
    expect(result.detail).toBe("RPC_REJECTED");
    expect(result).toMatchObject({ sendDiagnostic: { errorResultState: "DECODED",
      transactionCode: "txBadAuth", latestLedger: 1 } });
    expect(f.output).toHaveBeenCalledWith("Código de transacción: txBadAuth");
    expect(f.output.mock.calls.map(([line]) => line).join("\n"))
      .not.toContain(errorResult.toXdr("base64"));
    expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
  });

  it("respuesta de envío malformada conserva incertidumbre y no reintenta", async () => {
    const f = fixture({ sendStatus: "TRY_AGAIN_LATER" });
    const result = await runManualOneAnchor(f.deps);
    expect(result).toMatchObject({ state: "UNCERTAIN", code: "SEND_UNCERTAIN", sendAttempted: true });
    expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
    expect(f.processRunner.run).toHaveBeenCalledOnce();
    const duplicate = fixture({ sendStatus: "DUPLICATE" });
    expect(await runManualOneAnchor(duplicate.deps)).toMatchObject({
      state: "UNCERTAIN", code: "SEND_UNCERTAIN", sendAttempted: true,
    });
    expect(duplicate.submitTransport.sendTransaction).toHaveBeenCalledOnce();
  });

  it("conserva hash y vía de solo lectura si envío queda incierto por timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const f = fixture({ hangSend: true });
      const sendTransaction = vi.mocked(f.submitTransport.sendTransaction);
      const pending = runManualOneAnchor(f.deps);
      for (let attempt = 0; attempt < 100 && !sendTransaction.mock.calls.length; attempt += 1) {
        await new Promise<void>((resolve) => realSetImmediate(resolve));
      }
      expect(sendTransaction).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_001);
      const result = await pending;
      expect(result.state).toBe("UNCERTAIN");
      expect(result.txHash).toMatch(/^[0-9a-f]{64}$/u);
      expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
      expect(f.output).toHaveBeenCalledWith(expect.stringContaining("--reconcile-readonly"));
      expect(result).toMatchObject({ phase: "SEND", code: "SEND_UNCERTAIN", sendAttempted: true });
    } finally { vi.useRealTimers(); }
  });

  it("NOT_FOUND sigue ambiguo y el mismo hash puede confirmarse después solo por lectura", async () => {
    const f = fixture({ transactionStatus: "NOT_FOUND" });
    const first = await runManualOneAnchor(f.deps);
    expect(first.state).toBe("UNCERTAIN");
    if (first.state === "CONFIRMED") throw new Error();
    expect(first.detail).toBe("TX_NOT_FOUND_AMBIGUOUS");
    expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
    f.state.transactionStatus = "SUCCESS";
    f.state.stored = HASH;
    const later = await runReadonlyReconciliation({
      txHash: first.txHash!, messageKeyHex: first.messageKeyHex, jwsHashHex: first.jwsHashHex,
    }, { readServerFactory: f.deps.readServerFactory, output: f.output });
    expect(later.state).toBe("CONFIRMED");
    expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
  });

  it("FAILED y SUCCESS sin lectura coincidente no confirman", async () => {
    const failed = fixture({ transactionStatus: "FAILED" });
    expect((await runManualOneAnchor(failed.deps)).state).toBe("FAILED");
    const successWithoutRead = fixture({ transactionStatus: "SUCCESS" });
    const result = await runManualOneAnchor(successWithoutRead.deps);
    expect(result.state).toBe("UNCERTAIN");
    if (result.state === "CONFIRMED") throw new Error();
    expect(result.detail).toBe("TX_SUCCESS_WITHOUT_MATCHING_READ");
    expect(result).toMatchObject({ code: "RECONCILIATION_UNCERTAIN", sendAttempted: true });
  });

  it("lectura discrepante produce CONFLICT", async () => {
    const f = fixture({ transactionStatus: "SUCCESS", recordAfterSend: new Uint8Array(32).fill(9) });
    expect((await runManualOneAnchor(f.deps)).state).toBe("CONFLICT");
  });

  it("rechaza XDR preparado con argumentos distintos antes de pedir aprobación", () => {
    const tx = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
      xdr.ScVal.scvBytes(KEY), xdr.ScVal.scvBytes(HASH))).setTimeout(30).build();
    expect(() => inspectPreparedManualAnchor({
      transactionXdr: tx.toXdr(), transactionHash: Buffer.from(tx.hash()).toString("hex"),
      contractId: TRUSTED_TESTNET.contractId,
      messageKey: KEY, jwsHash: new Uint8Array(32).fill(9),
    })).toThrow("MANUAL_PREPARED_ARGUMENTS_REJECTED");
  });

  it("rechaza un XDR manual que exceda 180 segundos aunque su hash sea exacto", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-26T12:00:00.000Z"));
      const tx = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
        fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
      }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
        xdr.ScVal.scvBytes(KEY), xdr.ScVal.scvBytes(HASH))).setTimeout(181).build();
      expect(() => inspectPreparedManualAnchor({ transactionXdr: tx.toXdr(),
        transactionHash: Buffer.from(tx.hash()).toString("hex"),
        contractId: TRUSTED_TESTNET.contractId, messageKey: KEY, jwsHash: HASH,
      })).toThrow("MANUAL_PREPARED_XDR_REJECTED");
    } finally { vi.useRealTimers(); }
  });

  it("modo CLI por defecto no abre red y CI bloquea escritura antes de RPC", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await expect(main([])).resolves.toBe(0);
    vi.stubEnv("CI", "true");
    try {
      await expect(main(["--execute-testnet-write"])).resolves.toBe(3);
      await expect(main([
        "--execute-testnet-write", "--max-testnet-fee-stroops", "3000000",
      ])).resolves.toBe(3);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("sin RPC"));
    } finally { vi.unstubAllEnvs(); write.mockRestore(); }
  });

  it("bloquea el runner real si otro módulo lo importa fuera del entrypoint manual", async () => {
    const f = fixture();
    const spawnFake = vi.fn(() => { throw new Error("must not spawn"); });
    await expect(runManualOneAnchor({
      ...f.deps,
      processRunner: new NodeStellarCliProcessRunner(
        spawnFake as unknown as typeof import("node:child_process").spawn,
      ),
    })).rejects.toThrow("MANUAL_ENTRYPOINT_REQUIRED");
    expect(f.server.getNetwork).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    expect(spawnFake).not.toHaveBeenCalled();
  });

  it("diagnostica y prepara solo con capacidades de lectura, sin firmante ni envío", async () => {
    const f = fixture();
    const result = await runReadonlyDiagnosis(diagnosisDeps(f));
    expect(result).toMatchObject({ state: "READY_READONLY", detail: "NO_SIGN_OR_SEND_CAPABILITY" });
    expect(result.txHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(f.submitTransport.simulateTransaction).toHaveBeenCalledOnce();
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    const printed = f.output.mock.calls.map(([line]) => line).join("\n");
    expect(printed).toContain(Buffer.from(KEY).toString("hex"));
    expect(printed).toContain(Buffer.from(HASH).toString("hex"));
    expect(printed).toContain(labEvidence.compact);
    expect(printed).not.toContain('"d":');
    expect(f.output).toHaveBeenCalledWith(expect.stringContaining("NO_SIGN_OR_SEND_CAPABILITY"));
    expect(f.output).toHaveBeenCalledWith("Comisión del XDR ensamblado: 200 stroops");
    expect(f.output).toHaveBeenCalledWith("Regla de comisión: WITHIN_LIMIT");
  });

  it("el diagnóstico read-only prepara 180 segundos sin construir firma ni envío", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-26T12:00:00.000Z");
      vi.setSystemTime(start);
      const f = fixture();
      expect(await runReadonlyDiagnosis(diagnosisDeps(f))).toMatchObject({
        state: "READY_READONLY", detail: "NO_SIGN_OR_SEND_CAPABILITY",
      });
      const raw = vi.mocked(f.submitTransport.simulateTransaction).mock.calls[0]![0];
      expect(Number(raw.timeBounds!.maxTime) - Math.floor(start.getTime() / 1_000)).toBe(180);
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("acepta 28284 y 40000 stroops exactos solo para preparación manual Testnet", async () => {
    for (const [resourceFee, total] of [[28184, 28284], [39900, 40000]] as const) {
      const f = fixture({ fee: String(resourceFee), resourceFee });
      const result = await runReadonlyDiagnosis(diagnosisDeps(f));
      expect(result).toMatchObject({ state: "READY_READONLY", detail: "NO_SIGN_OR_SEND_CAPABILITY" });
      expect(f.output).toHaveBeenCalledWith(`Comisión total calculada: ${total} stroops`);
      expect(f.output).toHaveBeenCalledWith(`Comisión del XDR ensamblado: ${total} stroops`);
      expect(f.output).toHaveBeenCalledWith(
        "Presupuesto máximo configurado: 40000 stroops (0.0040000 XLM de prueba)",
      );
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("rechaza el total real con el valor predeterminado y solo supera el presupuesto explícito tras simularlo", async () => {
    const defaultBudget = fixture({ fee: "2614689", resourceFee: 2614689 });
    expect(await runManualOneAnchor(defaultBudget.deps)).toMatchObject({
      state: "BLOCKED", phase: "SIMULATION", code: "PREPARATION_FAILED",
      detail: "SIMULATION_FEE_LIMIT_EXCEEDED", sendAttempted: false,
    });
    expect(defaultBudget.output).toHaveBeenCalledWith("Comisión mínima de recursos simulada: 2614689 stroops");
    expect(defaultBudget.output).toHaveBeenCalledWith("Comisión total calculada: 2614789 stroops");
    expect(defaultBudget.output).toHaveBeenCalledWith(
      "Presupuesto máximo configurado: 40000 stroops (0.0040000 XLM de prueba)",
    );
    expect(defaultBudget.approveTransaction).not.toHaveBeenCalled();
    expect(defaultBudget.processRunner.run).not.toHaveBeenCalled();
    expect(defaultBudget.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("restringe el argumento de presupuesto al modo write y a stroops enteros hasta 3.000.000", async () => {
    expect(parseManualTestnetFeeBudget(["--execute-testnet-write"])).toBe(40_000n);
    expect(parseManualTestnetFeeBudget([
      "--execute-testnet-write", "--max-testnet-fee-stroops", "3000000",
    ])).toBe(3_000_000n);
    for (const value of ["-1", "3000001", "2.5", "1e6", "0", "99", "03000000", ""]) {
      expect(parseManualTestnetFeeBudget([
        "--execute-testnet-write", "--max-testnet-fee-stroops", value,
      ])).toBeNull();
    }
    expect(parseManualTestnetFeeBudget([
      "--diagnose-readonly", "--max-testnet-fee-stroops", "3000000",
    ])).toBeNull();
    expect(parseManualTestnetFeeBudget([
      "--execute-testnet-write", "--max-testnet-fee-stroops",
    ])).toBeNull();

    const f = fixture();
    await expect(main([
      "--diagnose-readonly", "--max-testnet-fee-stroops", "3000000",
    ], diagnosisDeps(f))).resolves.toBe(2);
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(main([
        "--execute-testnet-write", "--max-testnet-fee-stroops", "3000001",
      ])).resolves.toBe(2);
      expect(write).toHaveBeenCalledWith(expect.stringContaining("Presupuesto inválido"));
    } finally { write.mockRestore(); }
    expect(f.server.getNetwork).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("la ruta manual con aprobación denegada prepara 28284 sin ejecutar firma ni envío", async () => {
    const f = fixture({ fee: "28184", resourceFee: 28184, approved: false });
    const result = await runManualOneAnchor(f.deps);
    expect(result).toMatchObject({ state: "BLOCKED", phase: "AUTHORIZATION", sendAttempted: false });
    expect(f.approveTransaction).toHaveBeenCalledWith(expect.objectContaining({
      feeStroops: "28284", maxFeeStroops: "40000",
    }));
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("solo el runner manual prepara 180 segundos y tolera aprobación posterior a 30 segundos", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-26T12:00:00.000Z");
      vi.setSystemTime(start);
      const f = fixture({ transactionStatus: "SUCCESS", recordAfterSend: HASH });
      const result = await runManualOneAnchor({ ...f.deps,
        approveTransaction: async (intent) => {
          expect(Number(intent.maxTime) - Math.floor(start.getTime() / 1_000)).toBe(180);
          vi.setSystemTime(new Date(start.getTime() + 31_000));
          return true;
        },
      });
      expect(result.state).toBe("CONFIRMED");
      expect(f.submitTransport.simulateTransaction).toHaveBeenCalledOnce();
      expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("permite exactamente 20 segundos y bloquea menos de 20 antes de pedir firma", async () => {
    for (const [elapsedSeconds, allowed] of [[160, true], [161, false], [181, false]] as const) {
      vi.useFakeTimers();
      try {
        const start = new Date("2026-10-26T12:00:00.000Z");
        vi.setSystemTime(start);
        const f = fixture();
        const result = await runManualOneAnchor({ ...f.deps,
          approveTransaction: async () => {
            vi.setSystemTime(new Date(start.getTime() + elapsedSeconds * 1_000));
            return true;
          },
        });
        if (allowed) {
          expect(f.submitTransport.sendTransaction).toHaveBeenCalledOnce();
        } else {
          expect(result).toMatchObject({ state: "BLOCKED", sendAttempted: false,
            detail: elapsedSeconds > 180 ? "TRANSACTION_TIMEBOUNDS_EXPIRED" :
              "TRANSACTION_TIME_MARGIN_INSUFFICIENT" });
          expect(f.processRunner.run).not.toHaveBeenCalled();
          expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
          expect(f.submitTransport.getAccount).toHaveBeenCalledOnce();
          expect(f.submitTransport.simulateTransaction).toHaveBeenCalledOnce();
        }
      } finally { vi.useRealTimers(); }
    }
  });

  it("si vence durante el firmante, no renueva XDR, hash o secuencia ni envía", async () => {
    vi.useFakeTimers();
    try {
      const start = new Date("2026-10-26T12:00:00.000Z");
      vi.setSystemTime(start);
      const f = fixture();
      vi.mocked(f.processRunner.run).mockImplementationOnce(async ({ stdin }) => {
        vi.setSystemTime(new Date(start.getTime() + 181_000));
        return { exitCode: 0, stdout: signedXdr(stdin.replace(/\r?\n$/u, "")) };
      });
      const result = await runManualOneAnchor(f.deps);
      expect(result).toMatchObject({ state: "BLOCKED", detail: "TRANSACTION_TIMEBOUNDS_EXPIRED",
        sendAttempted: false });
      expect(f.processRunner.run).toHaveBeenCalledOnce();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
      expect(f.submitTransport.getAccount).toHaveBeenCalledOnce();
      expect(f.submitTransport.simulateTransaction).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("bloquea 40001 stroops y una comisión ensamblada distinta sin firma ni envío", async () => {
    const over = fixture({ fee: "39901", resourceFee: 39901 });
    expect(await runReadonlyDiagnosis(diagnosisDeps(over))).toMatchObject({
      state: "BLOCKED", detail: "SIMULATION_FEE_LIMIT_EXCEEDED", sendAttempted: false,
    });
    const mismatch = fixture({ fee: "28184", resourceFee: 28185 });
    expect(await runReadonlyDiagnosis(diagnosisDeps(mismatch))).toMatchObject({
      state: "BLOCKED", detail: "SIMULATION_ASSEMBLED_FEE_MISMATCH", sendAttempted: false,
    });
    expect(mismatch.output).toHaveBeenCalledWith("Comisión del XDR ensamblado: 28285 stroops");
    for (const f of [over, mismatch]) {
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("mantiene red, contrato y autorización Soroban fijados en el diagnóstico manual", async () => {
    const otherNetwork = fixture({ fee: "28184", resourceFee: 28184 });
    vi.mocked(otherNetwork.server.getNetwork).mockResolvedValueOnce({ passphrase: "Other Network" });
    expect(await runReadonlyDiagnosis(diagnosisDeps(otherNetwork))).toMatchObject({
      state: "BLOCKED", sendAttempted: false,
    });
    const otherContract = fixture();
    const wrongContractId = "C" + "A".repeat(55);
    expect(() => inspectPreparedManualAnchor({
      transactionXdr: "not-an-xdr", transactionHash: "0".repeat(64),
      contractId: wrongContractId, messageKey: KEY, jwsHash: HASH,
    })).toThrow("MANUAL_CONTRACT_REJECTED");
    const wrongAuth = fixture({ fee: "28184", resourceFee: 28184 });
    vi.mocked(wrongAuth.submitTransport.simulateTransaction).mockResolvedValueOnce({
      id: "offline", latestLedger: 1, events: [], _parsed: true,
      transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100).setResourceFee(28184),
      minResourceFee: "28184", result: { auth: [{}], retval: xdr.ScVal.scvVoid() },
    } as never);
    expect(await runReadonlyDiagnosis(diagnosisDeps(wrongAuth))).toMatchObject({
      state: "BLOCKED", detail: "SIMULATION_AUTH_INVALID", sendAttempted: false,
    });
    for (const f of [otherNetwork, otherContract, wrongAuth]) {
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("la rama CLI --diagnose-readonly usa dobles y no crea una ruta de envío", async () => {
    const f = fixture();
    await expect(main(["--diagnose-readonly"], diagnosisDeps(f))).resolves.toBe(0);
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
    expect(f.processRunner.run).not.toHaveBeenCalled();
  });

  it("clasifica red, WASM, lectura, cuenta y simulación sin exponer errores RPC", async () => {
    const cases = [
      { phase: "NETWORK", change: (f: ReturnType<typeof fixture>) =>
        vi.mocked(f.server.getNetwork).mockRejectedValueOnce(new Error("SECRET_NETWORK_RESPONSE")) },
      { phase: "WASM", change: (f: ReturnType<typeof fixture>) =>
        vi.mocked(f.server.getContractWasmByContractId!).mockRejectedValueOnce(new Error("SECRET_WASM_RESPONSE")) },
      { phase: "CONTRACT_READ", change: (f: ReturnType<typeof fixture>) =>
        vi.mocked(f.server.simulateTransaction).mockRejectedValueOnce(new Error("SECRET_READ_RESPONSE")) },
      { phase: "ACCOUNT", change: (f: ReturnType<typeof fixture>) =>
        vi.mocked(f.submitTransport.getAccount).mockRejectedValueOnce(new Error("SECRET_ACCOUNT_RESPONSE")) },
      { phase: "SIMULATION", change: (f: ReturnType<typeof fixture>) =>
        vi.mocked(f.submitTransport.simulateTransaction).mockRejectedValueOnce(new Error("SECRET_SIMULATION_RESPONSE")) },
    ] as const;
    for (const sample of cases) {
      const f = fixture();
      sample.change(f);
      const result = await runReadonlyDiagnosis(diagnosisDeps(f));
      expect(result).toMatchObject({ state: "BLOCKED", phase: sample.phase, sendAttempted: false });
      expect(result).toMatchObject({
        code: sample.phase === "SIMULATION" ? "PREPARATION_FAILED" : "PREFLIGHT_FAILED",
      });
      expect(f.processRunner.run).not.toHaveBeenCalled();
      expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
      const printed = f.output.mock.calls.map(([line]) => line).join("\n");
      expect(printed).not.toContain("SECRET_");
      if (sample.phase === "NETWORK") expect(result).toMatchObject({ detail: "NETWORK_QUERY_FAILED" });
      if (sample.phase === "WASM") expect(result).toMatchObject({ detail: "WASM_QUERY_FAILED" });
      if (sample.phase === "CONTRACT_READ") expect(result).toMatchObject({ detail: "CONTRACT_READ_FAILED" });
      expect(printed).toContain(Buffer.from(KEY).toString("hex"));
      expect(printed).toContain(Buffer.from(HASH).toString("hex"));
    }
  });

  it("distingue rechazo RPC, autorización presente y comisión sobre el límite en solo lectura", async () => {
    const rpcRejected = fixture();
    vi.mocked(rpcRejected.submitTransport.simulateTransaction)
      .mockRejectedValueOnce(new Error("SENSITIVE_RPC_DETAIL"));
    const rpcResult = await runReadonlyDiagnosis(diagnosisDeps(rpcRejected));
    expect(rpcResult).toMatchObject({
      state: "BLOCKED", phase: "SIMULATION", code: "PREPARATION_FAILED",
      detail: "SIMULATION_RPC_FAILED", sendAttempted: false,
    });

    const authorization = fixture();
    vi.mocked(authorization.submitTransport.simulateTransaction).mockResolvedValueOnce({
      id: "offline", latestLedger: 1, events: [], _parsed: true,
      transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100).setResourceFee(100),
      minResourceFee: "100", result: { auth: [{}], retval: xdr.ScVal.scvVoid() },
    } as never);
    const authorizationResult = await runReadonlyDiagnosis(diagnosisDeps(authorization));
    expect(authorizationResult).toMatchObject({
      state: "BLOCKED", phase: "SIMULATION", code: "PREPARATION_FAILED",
      detail: "SIMULATION_AUTH_INVALID", sendAttempted: false,
    });

    const fee = fixture({ fee: "39901" });
    const feeResult = await runReadonlyDiagnosis(diagnosisDeps(fee));
    expect(feeResult).toMatchObject({
      state: "BLOCKED", phase: "SIMULATION", code: "PREPARATION_FAILED",
      detail: "SIMULATION_FEE_LIMIT_EXCEEDED", sendAttempted: false,
    });
    expect(fee.output).toHaveBeenCalledWith("Comisión base configurada: 100 stroops");
    expect(fee.output).toHaveBeenCalledWith("Comisión mínima de recursos simulada: 39901 stroops");
    expect(fee.output).toHaveBeenCalledWith("Comisión total calculada: 40001 stroops");
    expect(fee.output).toHaveBeenCalledWith("Comisión del XDR ensamblado: no disponible stroops");
    expect(fee.output).toHaveBeenCalledWith(
      "Presupuesto máximo configurado: 40000 stroops (0.0040000 XLM de prueba)",
    );
    expect(fee.output).toHaveBeenCalledWith("Regla de comisión: CALCULATED_TOTAL_EXCEEDS_MAX");

    for (const sample of [rpcRejected, authorization, fee]) {
      const printed = sample.output.mock.calls.map(([line]) => line).join("\n");
      expect(printed).not.toContain("SENSITIVE_RPC_DETAIL");
      expect(sample.processRunner.run).not.toHaveBeenCalled();
      expect(sample.submitTransport.sendTransaction).not.toHaveBeenCalled();
    }
  });

  it("clasifica la segunda preflight y la preparación antes de cualquier envío", async () => {
    const second = fixture();
    vi.mocked(second.server.getNetwork).mockResolvedValueOnce({ passphrase: TRUSTED_TESTNET.networkPassphrase })
      .mockResolvedValueOnce({ passphrase: "unexpected" });
    expect(await runManualOneAnchor(second.deps)).toMatchObject({
      state: "BLOCKED", phase: "NETWORK", code: "PREFLIGHT_FAILED", sendAttempted: false,
    });
    const fee = fixture({ fee: "39901" });
    expect(await runReadonlyDiagnosis(diagnosisDeps(fee))).toMatchObject({
      state: "BLOCKED", phase: "SIMULATION", code: "PREPARATION_FAILED", sendAttempted: false,
    });
    expect(second.submitTransport.sendTransaction).not.toHaveBeenCalled();
    expect(fee.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("un fallo al ensamblar el XDR queda como preparación sin envío", async () => {
    const f = fixture();
    vi.mocked(f.submitTransport.simulateTransaction).mockResolvedValueOnce({
      id: "offline", latestLedger: 1, events: [], _parsed: true,
      transactionData: null,
      minResourceFee: "100",
      result: {
        auth: [registerAlertAuthorization({ messageKey: KEY, jwsHash: HASH })],
        retval: xdr.ScVal.scvVoid(),
      },
    } as unknown as Awaited<ReturnType<SorobanSubmitRpc["simulateTransaction"]>>);
    const result = await runReadonlyDiagnosis(diagnosisDeps(f));
    expect(result).toMatchObject({
      state: "BLOCKED", phase: "XDR_PREPARATION", code: "PREPARATION_FAILED", sendAttempted: false,
    });
    expect(f.output.mock.calls.map(([line]) => line).join("\n")).not.toContain("transactionData");
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });

  it("una excepción de aprobación no se transforma en incertidumbre de envío", async () => {
    const f = fixture();
    const result = await runManualOneAnchor({
      ...f.deps, approveTransaction: async () => { throw new Error("SECRET_APPROVAL_PAYLOAD"); },
    });
    expect(result).toMatchObject({
      state: "BLOCKED", phase: "AUTHORIZATION", code: "AUTHORIZATION_DENIED", sendAttempted: false,
    });
    expect(f.output.mock.calls.map(([line]) => line).join("\n")).not.toContain("SECRET_APPROVAL_PAYLOAD");
    expect(f.processRunner.run).not.toHaveBeenCalled();
    expect(f.submitTransport.sendTransaction).not.toHaveBeenCalled();
  });
});
