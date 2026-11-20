import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline/promises";
import {
  inspectPreparedAdminRegisterAlertXdr, MANUAL_TESTNET_MAX_FEE_STROOPS, verifySignedAdminXdr,
  type SorobanTransactionSigner,
} from "./stellar-sdk-admin-submitter.js";
import { TRUSTED_TESTNET } from "./trusted-testnet-deployment.js";

const EXECUTABLE = "D:\\Stellar CLI\\stellar.exe";
const IDENTITY = "siga-e-testnet-admin";
const ARGS = Object.freeze(["tx", "sign", "--network", "testnet", "--sign-with-key", IDENTITY]);

export interface StellarCliProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly shell: false;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly signal?: AbortSignal;
}

export interface StellarCliProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
}

export interface StellarCliProcessRunner {
  run(input: StellarCliProcessInput): Promise<StellarCliProcessResult>;
}

export interface StellarCliSignerConfig {
  readonly enabled?: boolean;
  readonly executable: string;
  readonly identityAlias: string;
  readonly maxFeeStroops: bigint;
  readonly timeoutMs: number;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

export type StellarCliSignerErrorCode =
  | "CLI_SIGNING_DISABLED" | "CLI_AUTHORIZATION_REQUIRED" | "CLI_BUSY"
  | "CLI_XDR_REJECTED" | "CLI_PROCESS_FAILED" | "CLI_TIMEOUT"
  | "CLI_CANCELLED" | "CLI_OUTPUT_REJECTED" | "CLI_INTERACTIVE_APPROVAL_REQUIRED";

export class StellarCliSignerError extends Error {
  constructor(readonly code: StellarCliSignerErrorCode) {
    super(code);
  }
}

function fail(code: StellarCliSignerErrorCode): never {
  throw new StellarCliSignerError(code);
}

async function requireInteractiveApproval(transactionHash: string, signal?: AbortSignal): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail("CLI_INTERACTIVE_APPROVAL_REQUIRED");
  }
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const challenge = `FIRMAR REGISTER_ALERT ${transactionHash}`;
  try {
    const answer = await terminal.question(
      `Autorización humana para firma local. Escriba exactamente:\n${challenge}\n> `,
      { signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(60_000)])
        : AbortSignal.timeout(60_000) },
    );
    if (answer !== challenge) fail("CLI_INTERACTIVE_APPROVAL_REQUIRED");
  } catch {
    fail("CLI_INTERACTIVE_APPROVAL_REQUIRED");
  } finally {
    terminal.close();
  }
}

/** Explicit Node process transport. Never constructed by API startup. */
export class NodeStellarCliProcessRunner implements StellarCliProcessRunner {
  constructor(private readonly spawnProcess: typeof spawn = spawn) {}

  async run(input: StellarCliProcessInput): Promise<StellarCliProcessResult> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.spawnProcess(input.executable, [...input.args], {
          shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        reject(new StellarCliSignerError("CLI_PROCESS_FAILED"));
        return;
      }
      let done = false;
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const chunks: Buffer[] = [];
      const finish = (result: StellarCliProcessResult | StellarCliSignerError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
        if (result instanceof StellarCliSignerError) {
          try { child.kill(); } catch { /* Process may already have exited. */ }
          reject(result);
        } else resolve(result);
      };
      const onAbort = () => finish(new StellarCliSignerError("CLI_CANCELLED"));
      const timer = setTimeout(() => finish(new StellarCliSignerError("CLI_TIMEOUT")), input.timeoutMs);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      if (input.signal?.aborted) { onAbort(); return; }
      child.stdout.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > input.maxOutputBytes) {
          finish(new StellarCliSignerError("CLI_OUTPUT_REJECTED"));
        } else chunks.push(Buffer.from(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderrBytes += chunk.length;
        if (stderrBytes > input.maxOutputBytes) finish(new StellarCliSignerError("CLI_PROCESS_FAILED"));
      });
      child.on("error", () => finish(new StellarCliSignerError("CLI_PROCESS_FAILED")));
      child.on("close", (code) => finish({ exitCode: code, stdout: Buffer.concat(chunks).toString("utf8") }));
      child.stdin.on("error", () => finish(new StellarCliSignerError("CLI_PROCESS_FAILED")));
      child.stdin.end(input.stdin, "utf8");
    });
  }
}

/** One signing operation requires one fresh caller approval for the exact tx hash. */
export class StellarCliSecureStoreSigner implements SorobanTransactionSigner {
  readonly publicAddress = TRUSTED_TESTNET.adminPublicAddress;
  private readonly config: StellarCliSignerConfig;
  private readonly consumed = new WeakSet<object>();
  private busy = false;

  constructor(config: StellarCliSignerConfig, private readonly runner: StellarCliProcessRunner) {
    if (config.executable !== EXECUTABLE || config.identityAlias !== IDENTITY ||
        typeof config.maxFeeStroops !== "bigint" || config.maxFeeStroops < 1n ||
        config.maxFeeStroops > MANUAL_TESTNET_MAX_FEE_STROOPS ||
        !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 60_000 ||
        !Number.isSafeInteger(config.maxInputBytes) || config.maxInputBytes < 1 ||
        config.maxInputBytes > 100_000 ||
        !Number.isSafeInteger(config.maxOutputBytes) || config.maxOutputBytes < 1 ||
        config.maxOutputBytes > 100_000) {
      throw new TypeError("STELLAR_CLI_SIGNER_CONFIGURATION_INVALID");
    }
    this.config = Object.freeze({ ...config });
  }

  async signPreparedXdr(input: Parameters<SorobanTransactionSigner["signPreparedXdr"]>[0]): Promise<string> {
    if (this.config.enabled !== true) fail("CLI_SIGNING_DISABLED");
    if (this.busy) fail("CLI_BUSY");
    const approval = input.authorization;
    if (!approval || this.consumed.has(approval) || approval.approved !== true ||
        approval.purpose !== "register_alert" ||
        approval.transactionHash !== input.transactionHash ||
        !Number.isSafeInteger(approval.expiresAtMs) ||
        approval.expiresAtMs <= Date.now() || approval.expiresAtMs > Date.now() + 60_000) {
      fail("CLI_AUTHORIZATION_REQUIRED");
    }
    if (input.signal?.aborted) fail("CLI_CANCELLED");
    if (Buffer.byteLength(input.transactionXdr, "utf8") > this.config.maxInputBytes) {
      fail("CLI_XDR_REJECTED");
    }
    let prepared;
    try {
      prepared = inspectPreparedAdminRegisterAlertXdr({
        transactionXdr: input.transactionXdr,
        transactionHash: input.transactionHash,
        networkPassphrase: input.networkPassphrase,
        maxFeeStroops: this.config.maxFeeStroops,
      });
    } catch {
      return fail("CLI_XDR_REJECTED");
    }
    this.consumed.add(approval);
    this.busy = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      // A callback approval alone cannot start the real CLI in an unattended worker or HTTP process.
      if (this.runner instanceof NodeStellarCliProcessRunner) {
        await requireInteractiveApproval(input.transactionHash, input.signal);
      }
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => {
          controller.abort();
          reject(new StellarCliSignerError("CLI_CANCELLED"));
        };
        input.signal?.addEventListener("abort", onAbort, { once: true });
      });
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new StellarCliSignerError("CLI_TIMEOUT"));
        }, this.config.timeoutMs);
      });
      if (input.signal?.aborted) fail("CLI_CANCELLED");
      const result = await Promise.race([
        this.runner.run({
          executable: EXECUTABLE, args: ARGS, shell: false,
          stdin: `${input.transactionXdr}\n`, timeoutMs: this.config.timeoutMs,
          maxOutputBytes: this.config.maxOutputBytes, signal: controller.signal,
        }),
        cancelled, deadline,
      ]);
      if (result.exitCode !== 0) fail("CLI_PROCESS_FAILED");
      if (typeof result.stdout !== "string" ||
          Buffer.byteLength(result.stdout, "utf8") > this.config.maxOutputBytes) {
        fail("CLI_OUTPUT_REJECTED");
      }
      const signedXdr = result.stdout.replace(/\r?\n$/u, "");
      if (!signedXdr || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signedXdr)) {
        fail("CLI_OUTPUT_REJECTED");
      }
      try { verifySignedAdminXdr(prepared, signedXdr); }
      catch { return fail("CLI_OUTPUT_REJECTED"); }
      return signedXdr;
    } catch (error) {
      if (error instanceof StellarCliSignerError) throw error;
      return fail(input.signal?.aborted ? "CLI_CANCELLED" : "CLI_PROCESS_FAILED");
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) input.signal?.removeEventListener("abort", onAbort);
      this.busy = false;
    }
  }
}
