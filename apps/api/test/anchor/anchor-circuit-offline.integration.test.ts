import { Account, Contract, Keypair, SorobanDataBuilder, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  StellarCliSecureStoreSigner, type StellarCliProcessRunner,
} from "../../src/modules/anchor/stellar-cli-secure-store-signer.js";
import {
  StellarSdkSorobanAdminSubmitter, type SorobanSubmitRpc,
} from "../../src/modules/anchor/stellar-sdk-admin-submitter.js";
import {
  SorobanTestnetAnchorGateway, type SorobanTestnetRpcClient,
} from "../../src/modules/anchor/soroban-testnet-anchor-gateway.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import { registerAlertAuthorization } from "./soroban-auth-fixtures.js";

// Offline: no deployed WASM bytes or administrator private key are available to tests.
const wasmDigest = vi.hoisted(() => ({ value: "90c0f8c2be7a1a3a1d971574fb939cf55cbd6326ff513112198e2fdda18ac66f" }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: () => ({ update: () => ({ digest: () => wasmDigest.value }) }) };
});

const deployment = {
  id: "offline-circuit-fixture", network: TRUSTED_TESTNET.network,
  networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  contractId: TRUSTED_TESTNET.contractId, wasmHash: TRUSTED_TESTNET.wasmHash,
  adminPublicAddress: TRUSTED_TESTNET.adminPublicAddress,
  generation: 1, trustedConfigVersion: "offline-circuit-v1",
};
const messageKey = new Uint8Array(32).fill(0x11);
const jwsHash = new Uint8Array(32).fill(0x22);
const otherHash = new Uint8Array(32).fill(0x33);

function request(hash = jwsHash) {
  return {
    deployment, messageKey, jwsHash: hash,
    attemptCount: 1, leaseExpiresAt: new Date(Date.now() + 60_000),
  };
}

function simulation(resourceFee = "100") {
  return {
    id: "offline", latestLedger: 1, events: [], _parsed: true,
    transactionData: new SorobanDataBuilder().setResources(10_000, 100, 100).setResourceFee(100),
    minResourceFee: resourceFee,
    result: {
      auth: [registerAlertAuthorization({ messageKey, jwsHash })],
      retval: xdr.ScVal.scvVoid(),
    },
  };
}

function signedXdr(unsignedXdr: string, options: {
  readonly otherSigner?: boolean;
  readonly changeOperation?: boolean;
  readonly changeArguments?: boolean;
} = {}) {
  const unsigned = new Transaction(unsignedXdr, TRUSTED_TESTNET.networkPassphrase);
  let body = unsigned;
  if (options.changeOperation || options.changeArguments) {
    const operation = options.changeOperation
      ? new Contract(TRUSTED_TESTNET.contractId).call("get_alert", xdr.ScVal.scvBytes(messageKey))
      : new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
        xdr.ScVal.scvBytes(messageKey), xdr.ScVal.scvBytes(otherHash));
    body = TransactionBuilder.cloneFrom(unsigned).clearOperations().addOperation(operation).build();
  }
  const envelope = body.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error("fixture envelope invalid");
  const signerAddress = options.otherSigner
    ? StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(9))
    : TRUSTED_TESTNET.adminPublicAddress;
  return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
    tx: envelope.value.tx,
    signatures: [new xdr.DecoratedSignature({
      hint: Keypair.fromPublicKey(signerAddress).signatureHint(),
      signature: new Uint8Array(64).fill(0x55),
    })],
  })).toXdr("base64");
}

function circuit(options: {
  readonly sign?: Parameters<typeof signedXdr>[1];
  readonly sendStatus?: "PENDING" | "ERROR" | "TRY_AGAIN_LATER";
  readonly pendingSend?: boolean;
  readonly resourceFee?: string;
  readonly approved?: boolean;
  readonly maxFeeStroops?: bigint;
  readonly sharedApproval?: { approved: true; purpose: "register_alert"; transactionHash: string; expiresAtMs: number };
} = {}) {
  const state: {
    stored: Uint8Array | null;
    transactionStatus: "PENDING" | "NOT_FOUND" | "FAILED" | "SUCCESS";
    transactionLedger: number;
  } = { stored: null, transactionStatus: "PENDING", transactionLedger: 123 };
  const runner: StellarCliProcessRunner = {
    run: vi.fn(async ({ stdin }) => ({
      exitCode: 0, stdout: signedXdr(stdin.replace(/\r?\n$/u, ""), options.sign),
    })),
  };
  const signer = new StellarCliSecureStoreSigner({
    enabled: true, executable: "D:\\Stellar CLI\\stellar.exe",
    identityAlias: "siga-e-testnet-admin", maxFeeStroops: options.maxFeeStroops ?? 2_000n,
    timeoutMs: 50, maxInputBytes: 10_000, maxOutputBytes: 10_000,
  }, runner);
  const transport: SorobanSubmitRpc = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getContractWasmByContractId: vi.fn(async () => Uint8Array.from([0, 97, 115, 109])),
    getAccount: vi.fn(async () => new Account(TRUSTED_TESTNET.adminPublicAddress, "1")),
    simulateTransaction: vi.fn(async () => simulation(options.resourceFee)),
    sendTransaction: vi.fn(async (transaction) => {
      if (options.pendingSend) return new Promise<never>(() => {});
      return {
        status: options.sendStatus ?? "PENDING",
        hash: Buffer.from(transaction.hash()).toString("hex"),
        latestLedger: 1, latestLedgerCloseTime: 1,
      };
    }) as SorobanSubmitRpc["sendTransaction"],
  };
  const authorizeSigning = vi.fn(async ({ transactionHash }: { transactionHash: string }) =>
    options.approved === false ? null :
      options.sharedApproval ?? {
        approved: true as const, purpose: "register_alert" as const,
        transactionHash, expiresAtMs: Date.now() + 30_000,
      });
  const submitter = new StellarSdkSorobanAdminSubmitter({
    deployment, endpointUrl: TRUSTED_TESTNET.endpointUrl, submissionEnabled: true,
    timeoutMs: 50, transactionTimeoutSeconds: 30, baseFeeStroops: 100,
    maxFeeStroops: options.maxFeeStroops ?? 2_000n,
    maxInstructions: 1_000_000, maxDiskReadBytes: 10_000, maxWriteBytes: 10_000,
    authorizeSigning,
  }, transport, signer);
  const gatewayRpc: SorobanTestnetRpcClient = {
    getNetwork: vi.fn(async () => ({ passphrase: TRUSTED_TESTNET.networkPassphrase })),
    getTransaction: vi.fn(async ({ transactionHash }) => ({
      status: state.transactionStatus, txHash: transactionHash,
      ...(state.transactionStatus === "SUCCESS" ? { ledger: state.transactionLedger } : {}),
    })),
    getAlert: vi.fn(async ({ contractId, messageKey: key }) => ({
      contractId, method: "get_alert", messageKey: key,
      value: state.stored === null ? null : Uint8Array.from(state.stored),
    })),
  };
  const gateway = new SorobanTestnetAnchorGateway({
    enabled: true, submissionEnabled: true,
    endpointUrl: TRUSTED_TESTNET.endpointUrl, deployment, timeoutMs: 100,
  }, gatewayRpc, submitter);
  return { state, gateway, submitter, signer, runner, transport, gatewayRpc, authorizeSigning };
}

beforeEach(() => {
  wasmDigest.value = TRUSTED_TESTNET.wasmHash;
  vi.spyOn(Keypair.prototype, "verify").mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("circuito de anclaje M5 offline", () => {
  it("prepara, autoriza una vez, simula firma y envío PENDING, y solo confirma tras relectura coincidente", async () => {
    const subject = circuit();
    await expect(subject.gateway.reconcile(request(), null)).resolves.toMatchObject({ kind: "absent" });
    const submitted = await subject.gateway.submit(request());
    expect(submitted.kind).toBe("submitted");
    if (submitted.kind !== "submitted") throw new Error("expected PENDING receipt");
    expect(submitted.receipt.transactionStatus).toBe("PENDING");
    expect(subject.authorizeSigning).toHaveBeenCalledOnce();
    expect(subject.runner.run).toHaveBeenCalledOnce();
    expect(subject.transport.simulateTransaction).toHaveBeenCalledOnce();
    expect(subject.transport.sendTransaction).toHaveBeenCalledOnce();
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toEqual({ kind: "unknown", code: "RESULT_UNCERTAIN" });
    subject.state.transactionStatus = "SUCCESS";
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toEqual({ kind: "unknown", code: "RESULT_UNCERTAIN" });
    subject.state.stored = jwsHash;
    const confirmed = await subject.gateway.reconcile(request(), submitted.receipt.txHash);
    expect(confirmed.kind).toBe("confirmed");
    if (confirmed.kind === "confirmed") {
      expect(confirmed.evidence.source).toBe("transaction_and_readback");
      expect(confirmed.evidence.contractReadMatched).toBe(true);
      expect(confirmed.evidence.jwsHash).toEqual(jwsHash);
    }
  });

  it.each(["NOT_FOUND", "PENDING"] as const)("mantiene %s ambiguo sin lectura coincidente", async (status) => {
    const subject = circuit();
    const submitted = await subject.gateway.submit(request());
    if (submitted.kind !== "submitted") throw new Error();
    subject.state.transactionStatus = status;
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toEqual({ kind: "unknown", code: "RESULT_UNCERTAIN" });
  });

  it("trata FAILED sin registro como ausencia de esa transacción y SUCCESS sin registro como incierto", async () => {
    const subject = circuit();
    const submitted = await subject.gateway.submit(request());
    if (submitted.kind !== "submitted") throw new Error();
    subject.state.transactionStatus = "FAILED";
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toMatchObject({ kind: "absent", priorTransactionStatus: "FAILED" });
    subject.state.transactionStatus = "SUCCESS";
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toEqual({ kind: "unknown", code: "RESULT_UNCERTAIN" });
  });

  it("FAILED con lectura coincidente no confirma; hash distinto queda en conflicto", async () => {
    const subject = circuit();
    const submitted = await subject.gateway.submit(request());
    if (submitted.kind !== "submitted") throw new Error();
    subject.state.transactionStatus = "FAILED";
    subject.state.stored = jwsHash;
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toMatchObject({ kind: "matching_read", observedContractHash: jwsHash });
    subject.state.stored = otherHash;
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toMatchObject({ kind: "conflict", observedContractHash: otherHash });
  });

  it("detecta conflicto cuando la lectura del contrato difiere, aun con SUCCESS", async () => {
    const subject = circuit();
    const submitted = await subject.gateway.submit(request());
    if (submitted.kind !== "submitted") throw new Error();
    subject.state.transactionStatus = "SUCCESS";
    subject.state.stored = otherHash;
    await expect(subject.gateway.reconcile(request(), submitted.receipt.txHash))
      .resolves.toMatchObject({ kind: "conflict", observedContractHash: otherHash });
  });

  it("impide reutilizar la aprobación firmada para otro hash y no envía dos veces", async () => {
    const approval = {
      approved: true as const, purpose: "register_alert" as const,
      transactionHash: "", expiresAtMs: Date.now() + 30_000,
    };
    const subject = circuit({ sharedApproval: approval });
    subject.authorizeSigning.mockImplementation(async ({ transactionHash }) => {
      if (approval.transactionHash === "") approval.transactionHash = transactionHash;
      return approval;
    });
    await expect(subject.gateway.submit(request())).resolves.toMatchObject({ kind: "submitted" });
    await expect(subject.gateway.submit(request(otherHash))).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(subject.runner.run).toHaveBeenCalledOnce();
    expect(subject.transport.sendTransaction).toHaveBeenCalledOnce();
  });

  it.each([
    ["otra firma", { otherSigner: true }],
    ["otra operación", { changeOperation: true }],
    ["otros argumentos", { changeArguments: true }],
  ] as const)("rechaza %s después de firmar y nunca envía", async (_label, sign) => {
    const subject = circuit({ sign });
    await expect(subject.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(subject.transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza XDR con red, destino, argumentos o comisión alterados antes de firmar", async () => {
    const subject = circuit();
    const otherContract = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const variants = [
      { contractId: otherContract, args: [messageKey, jwsHash], fee: "100", passphrase: TRUSTED_TESTNET.networkPassphrase },
      { contractId: TRUSTED_TESTNET.contractId, args: [messageKey, new Uint8Array(31)], fee: "100", passphrase: TRUSTED_TESTNET.networkPassphrase },
      { contractId: TRUSTED_TESTNET.contractId, args: [messageKey, jwsHash], fee: "3000", passphrase: TRUSTED_TESTNET.networkPassphrase },
      { contractId: TRUSTED_TESTNET.contractId, args: [messageKey, jwsHash], fee: "100", passphrase: "Public Global Stellar Network ; September 2015" },
    ];
    for (const variant of variants) {
      const tx = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
        fee: variant.fee, networkPassphrase: variant.passphrase,
      }).addOperation(new Contract(variant.contractId).call("register_alert",
        ...variant.args.map((value) => xdr.ScVal.scvBytes(value))))
        .setTimeout(30).build();
      const hash = Buffer.from(tx.hash()).toString("hex");
      await expect(subject.signer.signPreparedXdr({
        transactionXdr: tx.toXdr(), networkPassphrase: variant.passphrase,
        transactionHash: hash,
        authorization: {
          approved: true, purpose: "register_alert", transactionHash: hash,
          expiresAtMs: Date.now() + 30_000,
        },
      })).rejects.toThrow("CLI_XDR_REJECTED");
    }
    expect(subject.runner.run).not.toHaveBeenCalled();
    expect(subject.transport.sendTransaction).not.toHaveBeenCalled();
  });

  it("rechaza red, WASM y comisiones antes de ejecutar el proceso de firma", async () => {
    const wrongNetwork = circuit();
    vi.mocked(wrongNetwork.transport.getNetwork).mockResolvedValue({ passphrase: "other" });
    await expect(wrongNetwork.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(wrongNetwork.runner.run).not.toHaveBeenCalled();
    wasmDigest.value = "0".repeat(64);
    const wrongWasm = circuit();
    await expect(wrongWasm.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(wrongWasm.runner.run).not.toHaveBeenCalled();
    wasmDigest.value = TRUSTED_TESTNET.wasmHash;
    const highFee = circuit({ resourceFee: "5000" });
    await expect(highFee.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(highFee.runner.run).not.toHaveBeenCalled();
  });

  it("rechazo RPC es definitivo; TRY_AGAIN_LATER y timeout tras enviar son inciertos", async () => {
    const rejected = circuit({ sendStatus: "ERROR" });
    await expect(rejected.gateway.submit(request()))
      .resolves.toMatchObject({ kind: "retryable_failure", code: "RPC_REJECTED",
        sendDiagnostic: { errorResultState: "MISSING", latestLedger: 1 } });
    const later = circuit({ sendStatus: "TRY_AGAIN_LATER" });
    await expect(later.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    const timeout = circuit({ pendingSend: true });
    await expect(timeout.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(timeout.transport.sendTransaction).toHaveBeenCalledOnce();
    expect(timeout.runner.run).toHaveBeenCalledOnce();
  });

  it("rechaza falta de autorización antes del proceso y del transporte de envío", async () => {
    const subject = circuit({ approved: false });
    await expect(subject.gateway.submit(request())).rejects.toThrow("SOROBAN_SUBMISSION_RESULT_UNCERTAIN");
    expect(subject.runner.run).not.toHaveBeenCalled();
    expect(subject.transport.sendTransaction).not.toHaveBeenCalled();
  });
});
