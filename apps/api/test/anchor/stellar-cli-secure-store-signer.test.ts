import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { Account, Contract, Keypair, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NodeStellarCliProcessRunner, StellarCliSecureStoreSigner, StellarCliSignerError,
  type StellarCliProcessRunner,
} from "../../src/modules/anchor/stellar-cli-secure-store-signer.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";
import { StellarSdkSorobanAdminSubmitter } from "../../src/modules/anchor/stellar-sdk-admin-submitter.js";

const EXECUTABLE = "D:\\Stellar CLI\\stellar.exe";
const config = {
  executable: EXECUTABLE, identityAlias: "siga-e-testnet-admin",
  maxFeeStroops: 2_000n, timeoutMs: 100, maxInputBytes: 10_000, maxOutputBytes: 10_000,
};
const messageKey = new Uint8Array(32).fill(1);
const jwsHash = new Uint8Array(32).fill(2);

function preparedTransaction() {
  const source = new Account(TRUSTED_TESTNET.adminPublicAddress, "1");
  return new TransactionBuilder(source, {
    fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
  }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
    xdr.ScVal.scvBytes(messageKey), xdr.ScVal.scvBytes(jwsHash))).setTimeout(30).build();
}

function mockSignedXdr(prepared: Transaction, hint = Keypair.fromPublicKey(TRUSTED_TESTNET.adminPublicAddress).signatureHint()) {
  const envelope = prepared.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error();
  return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
    tx: envelope.value.tx,
    signatures: [new xdr.DecoratedSignature({ hint, signature: new Uint8Array(64).fill(0x55) })],
  })).toXdr("base64");
}

function request(tx = preparedTransaction(), change: Record<string, unknown> = {}) {
  const hash = Buffer.from(tx.hash()).toString("hex");
  return {
    transactionXdr: tx.toXdr(), networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    transactionHash: hash,
    authorization: {
      approved: true as const, purpose: "register_alert" as const,
      transactionHash: hash, expiresAtMs: Date.now() + 30_000,
    },
    ...change,
  };
}

function harness(result?: { exitCode: number | null; stdout: string }) {
  const runner: StellarCliProcessRunner = {
    run: vi.fn(async () => result ?? ({ exitCode: 0, stdout: mockSignedXdr(preparedTransaction()) + "\n" })),
  };
  const signer = new StellarCliSecureStoreSigner({ ...config, enabled: true }, runner);
  return { runner, signer };
}

beforeEach(() => vi.spyOn(Keypair.prototype, "verify").mockReturnValue(true));
afterEach(() => vi.restoreAllMocks());

describe("StellarCliSecureStoreSigner", () => {
  it("acepta XDR sintético firmado y envía solo stdin al proceso inyectado", async () => {
    const { runner, signer } = harness();
    const input = request();
    await expect(signer.signPreparedXdr(input)).resolves.toBe(mockSignedXdr(preparedTransaction()));
    expect(runner.run).toHaveBeenCalledOnce();
    const processInput = vi.mocked(runner.run).mock.calls[0]![0];
    expect(processInput).toMatchObject({
      executable: EXECUTABLE, args: ["tx", "sign", "--network", "testnet", "--sign-with-key", "siga-e-testnet-admin"],
      shell: false, stdin: `${input.transactionXdr}\n`,
    });
    expect(processInput.args).not.toContain(input.transactionXdr);
    expect("sendTransaction" in signer).toBe(false);
  });

  it("permanece deshabilitado por defecto y exige autorización fresca", async () => {
    const { runner } = harness();
    expect(() => new StellarCliSecureStoreSigner({
      ...config, maxFeeStroops: 3_000_001n,
    }, runner)).toThrow("STELLAR_CLI_SIGNER_CONFIGURATION_INVALID");
    const disabled = new StellarCliSecureStoreSigner(config, runner);
    await expect(disabled.signPreparedXdr(request())).rejects.toThrow("CLI_SIGNING_DISABLED");
    const enabled = new StellarCliSecureStoreSigner({ ...config, enabled: true }, runner);
    const { authorization: _authorization, ...withoutApproval } = request();
    await expect(enabled.signPreparedXdr(withoutApproval)).rejects.toThrow("CLI_AUTHORIZATION_REQUIRED");
    const stale = request();
    stale.authorization.expiresAtMs = Date.now() - 1;
    await expect(enabled.signPreparedXdr(stale)).rejects.toThrow("CLI_AUTHORIZATION_REQUIRED");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("impide activar el runner real desde un proceso sin TTY aunque el callback autoapruebe", async () => {
    const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: false });
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
    try {
      const spawnFake = vi.fn(() => { throw new Error("must not spawn"); }) as unknown as typeof import("node:child_process").spawn;
      const signer = new StellarCliSecureStoreSigner({ ...config, enabled: true },
        new NodeStellarCliProcessRunner(spawnFake));
      await expect(signer.signPreparedXdr(request())).rejects.toThrow("CLI_INTERACTIVE_APPROVAL_REQUIRED");
      expect(spawnFake).not.toHaveBeenCalled();
    } finally {
      if (stdinDescriptor) Object.defineProperty(process.stdin, "isTTY", stdinDescriptor);
      else Reflect.deleteProperty(process.stdin, "isTTY");
      if (stdoutDescriptor) Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      else Reflect.deleteProperty(process.stdout, "isTTY");
    }
  });

  it("rechaza rutas e identidades alternativas", () => {
    const { runner } = harness();
    for (const change of [
      { executable: "C:\\other\\stellar.exe" }, { identityAlias: "other" },
    ]) {
      expect(() => new StellarCliSecureStoreSigner({ ...config, ...change }, runner))
        .toThrow("STELLAR_CLI_SIGNER_CONFIGURATION_INVALID");
    }
  });

  it("rechaza red, XDR, origen, operación, argumentos y comisión inválidos antes del proceso", async () => {
    const { runner, signer } = harness();
    const other = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(9));
    const wrongSource = new TransactionBuilder(new Account(other, "1"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
      xdr.ScVal.scvBytes(messageKey), xdr.ScVal.scvBytes(jwsHash))).setTimeout(30).build();
    const wrongOperation = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("get_alert",
      xdr.ScVal.scvBytes(messageKey))).setTimeout(30).build();
    const wrongArgs = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
      xdr.ScVal.scvBytes(new Uint8Array(31)), xdr.ScVal.scvBytes(jwsHash))).setTimeout(30).build();
    const highFee = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
      fee: "3000", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
      xdr.ScVal.scvBytes(messageKey), xdr.ScVal.scvBytes(jwsHash))).setTimeout(30).build();
    for (const invalid of [
      { ...request(), networkPassphrase: "other" },
      { ...request(), transactionXdr: "not-base64" },
      { ...request(), transactionHash: "0".repeat(64), authorization: {
        approved: true as const, purpose: "register_alert" as const,
        transactionHash: "0".repeat(64), expiresAtMs: Date.now() + 30_000,
      } },
      request(wrongSource), request(wrongOperation), request(wrongArgs), request(highFee),
    ]) {
      await expect(signer.signPreparedXdr(invalid)).rejects.toThrow("CLI_XDR_REJECTED");
    }
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("rechaza firma de otra identidad y XDR firmado modificado", async () => {
    const otherHint = Keypair.fromPublicKey(StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(9))).signatureHint();
    const wrongIdentity = harness({ exitCode: 0, stdout: mockSignedXdr(preparedTransaction(), otherHint) });
    await expect(wrongIdentity.signer.signPreparedXdr(request())).rejects.toThrow("CLI_OUTPUT_REJECTED");
    const tamperedTx = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "1"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("get_alert",
      xdr.ScVal.scvBytes(messageKey))).setTimeout(30).build();
    const tampered = harness({ exitCode: 0, stdout: mockSignedXdr(tamperedTx) });
    await expect(tampered.signer.signPreparedXdr(request())).rejects.toThrow("CLI_OUTPUT_REJECTED");
    vi.spyOn(Keypair.prototype, "verify").mockReturnValue(false);
    const invalidSignature = harness();
    await expect(invalidSignature.signer.signPreparedXdr(request())).rejects.toThrow("CLI_OUTPUT_REJECTED");
  });

  it("rechaza fallo Secure Store, salida vacía, malformada o excesiva", async () => {
    for (const result of [
      { exitCode: 1, stdout: "" }, { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "bad output" }, { exitCode: 0, stdout: "A".repeat(10_001) },
    ]) {
      const { signer, runner } = harness(result);
      await expect(signer.signPreparedXdr(request())).rejects.toBeInstanceOf(StellarCliSignerError);
      expect(runner.run).toHaveBeenCalledOnce();
    }
  });

  it("no reintenta fallos y consume la autorización de una sola vez", async () => {
    const { signer, runner } = harness({ exitCode: 1, stdout: "" });
    const input = request();
    await expect(signer.signPreparedXdr(input)).rejects.toThrow("CLI_PROCESS_FAILED");
    await expect(signer.signPreparedXdr(input)).rejects.toThrow("CLI_AUTHORIZATION_REQUIRED");
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("rechaza una segunda operación concurrente", async () => {
    let finish!: (value: { exitCode: number; stdout: string }) => void;
    const runner: StellarCliProcessRunner = {
      run: vi.fn(() => new Promise<{ exitCode: number; stdout: string }>((resolve) => { finish = resolve; })),
    };
    const signer = new StellarCliSecureStoreSigner({ ...config, enabled: true }, runner);
    const transaction = preparedTransaction();
    const first = signer.signPreparedXdr(request(transaction));
    await expect(signer.signPreparedXdr(request())).rejects.toThrow("CLI_BUSY");
    finish({ exitCode: 0, stdout: mockSignedXdr(transaction) });
    await expect(first).resolves.toBeTypeOf("string");
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it("propaga timeout y cancelación sin segundo intento", async () => {
    const timeoutRunner: StellarCliProcessRunner = {
      run: vi.fn(async (): Promise<{ exitCode: number | null; stdout: string }> => { throw new StellarCliSignerError("CLI_TIMEOUT"); }),
    };
    const timeoutSigner = new StellarCliSecureStoreSigner({ ...config, enabled: true }, timeoutRunner);
    await expect(timeoutSigner.signPreparedXdr(request())).rejects.toThrow("CLI_TIMEOUT");
    expect(timeoutRunner.run).toHaveBeenCalledOnce();
    const controller = new AbortController(); controller.abort();
    const { signer, runner } = harness();
    await expect(signer.signPreparedXdr({ ...request(), signal: controller.signal })).rejects.toThrow("CLI_CANCELLED");
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("aplica su propio timeout y cancelación si el runner no responde", async () => {
    vi.useFakeTimers();
    try {
      const runner: StellarCliProcessRunner = {
        run: vi.fn(() => new Promise<{ exitCode: number | null; stdout: string }>(() => {})),
      };
      const signer = new StellarCliSecureStoreSigner({ ...config, enabled: true }, runner);
      const pending = expect(signer.signPreparedXdr(request())).rejects.toThrow("CLI_TIMEOUT");
      await vi.advanceTimersByTimeAsync(config.timeoutMs + 1);
      await pending;
      const passedSignal = vi.mocked(runner.run).mock.calls[0]?.[0].signal;
      expect(passedSignal?.aborted).toBe(true);
      const controller = new AbortController();
      const cancelled = expect(signer.signPreparedXdr({ ...request(), signal: controller.signal }))
        .rejects.toThrow("CLI_CANCELLED");
      controller.abort();
      await cancelled;
      expect(runner.run).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it("es compatible con el submitter sin habilitar envío por defecto", async () => {
    const { signer } = harness();
    const transport = {
      getNetwork: vi.fn(), getContractWasmByContractId: vi.fn(), getAccount: vi.fn(),
      simulateTransaction: vi.fn(), sendTransaction: vi.fn(),
    };
    const submitter = new StellarSdkSorobanAdminSubmitter({
      deployment: {
        id: "cli-signer-fixture", network: TRUSTED_TESTNET.network,
        networkPassphrase: TRUSTED_TESTNET.networkPassphrase, contractId: TRUSTED_TESTNET.contractId,
        wasmHash: TRUSTED_TESTNET.wasmHash, adminPublicAddress: TRUSTED_TESTNET.adminPublicAddress,
        generation: 1, trustedConfigVersion: "local-test",
      },
      endpointUrl: TRUSTED_TESTNET.endpointUrl, timeoutMs: 100, transactionTimeoutSeconds: 30,
      baseFeeStroops: 100, maxFeeStroops: 2_000n,
      maxInstructions: 1_000_000, maxDiskReadBytes: 10_000, maxWriteBytes: 10_000,
    }, transport, signer);
    await expect(submitter.registerAlert({
      endpointUrl: TRUSTED_TESTNET.endpointUrl,
      networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
      contractId: TRUSTED_TESTNET.contractId, messageKey, jwsHash,
      signal: new AbortController().signal,
    })).rejects.toThrow("SUBMISSION_DISABLED");
    expect(transport.sendTransaction).not.toHaveBeenCalled();
  });
});

describe("NodeStellarCliProcessRunner with simulated child", () => {
  it("spawns with shell false and sends XDR through stdin", async () => {
    const fake = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
    fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
    fake.kill = vi.fn(() => true);
    const spawnFake = vi.fn(() => fake) as unknown as typeof import("node:child_process").spawn;
    const runner = new NodeStellarCliProcessRunner(spawnFake);
    const chunks: Buffer[] = [];
    fake.stdin.on("data", (part: Buffer) => chunks.push(part));
    const pending = runner.run({
      executable: EXECUTABLE, args: ["tx", "sign"], shell: false,
      stdin: "prepared-xdr\n", timeoutMs: 100, maxOutputBytes: 100,
    });
    fake.stdout.emit("data", Buffer.from("signed-xdr\n"));
    fake.emit("close", 0);
    await expect(pending).resolves.toEqual({ exitCode: 0, stdout: "signed-xdr\n" });
    expect(Buffer.concat(chunks).toString("utf8")).toBe("prepared-xdr\n");
    expect(spawnFake).toHaveBeenCalledWith(EXECUTABLE, ["tx", "sign"], {
      shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
  });

  it("termina el proceso simulado al vencer el plazo", async () => {
    vi.useFakeTimers();
    try {
      const fake = new EventEmitter() as EventEmitter & ChildProcessWithoutNullStreams;
      fake.stdin = new PassThrough(); fake.stdout = new PassThrough(); fake.stderr = new PassThrough();
      fake.kill = vi.fn(() => true);
      const spawnFake = vi.fn(() => fake) as unknown as typeof import("node:child_process").spawn;
      const runner = new NodeStellarCliProcessRunner(spawnFake);
      const pending = expect(runner.run({
        executable: EXECUTABLE, args: ["tx", "sign"], shell: false,
        stdin: "xdr\n", timeoutMs: 100, maxOutputBytes: 100,
      })).rejects.toThrow("CLI_TIMEOUT");
      await vi.advanceTimersByTimeAsync(101);
      await pending;
      expect(fake.kill).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
});
