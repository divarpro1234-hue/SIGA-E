import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { win32 } from "node:path";
import {
  DPAPI_SIGNER_TIMEOUT_MS, MAX_DPAPI_IPC_REQUEST_BYTES,
  MAX_DPAPI_IPC_RESPONSE_BYTES, type DpapiIpcChannel,
  validateDpapiSignerRequestFrame, validateDpapiSignerResponseFrame,
  type DpapiSignerSignRequest,
} from "./dpapi-signer-ipc.js";
import { SigningError } from "./signing-error.js";

const failure = () => new SigningError("SIGNATURE_OPERATION_FAILED", "Puente local de firma no disponible.");
const hashPattern = /^[0-9a-f]{64}$/u;
const maximumBinaryBytes = 16 * 1024 * 1024;
const maximumStderrBytes = 4096;

export interface TrustedDotnetVerifierPolicy {
  readonly installationDirectory: string;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly assemblySha256: string;
}

type BridgeChild = Pick<ChildProcessWithoutNullStreams,
  "stdin" | "stdout" | "stderr" | "on" | "once" | "kill">;
type BridgeSpawn = (path: string, args: readonly string[], options: SpawnOptions) => BridgeChild;
type ReadBinary = (path: string, signal: AbortSignal) => Promise<Uint8Array>;

const spawnVerifier: BridgeSpawn = (path, args, options) =>
  spawn(path, [...args], options) as ChildProcessWithoutNullStreams;
const readApprovedBinary: ReadBinary = async (path, signal) => {
  const file = await open(path, "r");
  try {
    const initial = await file.stat();
    if (!initial.isFile() || !Number.isSafeInteger(initial.size) || initial.size < 1 ||
        initial.size > maximumBinaryBytes) throw failure();
    const bytes = Buffer.alloc(initial.size);
    for (let offset = 0; offset < bytes.length;) {
      if (signal.aborted) throw failure();
      const result = await file.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead < 1) throw failure();
      offset += result.bytesRead;
    }
    if (signal.aborted || (await file.stat()).size !== initial.size) throw failure();
    return bytes;
  } finally { await file.close(); }
};

function validPolicy(policy: TrustedDotnetVerifierPolicy | undefined): policy is TrustedDotnetVerifierPolicy {
  if (!policy || !win32.isAbsolute(policy.installationDirectory) ||
      !win32.isAbsolute(policy.executablePath) ||
      win32.basename(policy.executablePath).toLowerCase() !== "sigae.m3.dpapisigner.exe" ||
      win32.normalize(win32.dirname(policy.executablePath)).toLowerCase() !==
        win32.normalize(policy.installationDirectory).toLowerCase() ||
      !hashPattern.test(policy.executableSha256) || !hashPattern.test(policy.assemblySha256)) return false;
  return true;
}

/** One child for one framed request. Constructed only by an explicit caller; server.ts never does. */
export class DotnetVerifierBridgeChannel implements DpapiIpcChannel {
  private readonly policy: TrustedDotnetVerifierPolicy | undefined;

  constructor(
    policy?: TrustedDotnetVerifierPolicy,
    private readonly spawnProcess: BridgeSpawn = spawnVerifier,
    private readonly readBinary: ReadBinary = readApprovedBinary,
  ) {
    this.policy = policy ? Object.freeze({ ...policy }) : undefined;
  }

  async exchange(requestFrame: Uint8Array, options: {
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly maxResponseBytes: number;
  }): Promise<Uint8Array> {
    let request: DpapiSignerSignRequest;
    try {
      request = validateDpapiSignerRequestFrame(requestFrame);
    } catch {
      throw failure();
    }
    if (!validPolicy(this.policy) || !(requestFrame instanceof Uint8Array) ||
        requestFrame.byteLength < 5 || requestFrame.byteLength > MAX_DPAPI_IPC_REQUEST_BYTES + 4 ||
        Buffer.from(requestFrame).readUInt32BE(0) !== requestFrame.byteLength - 4 ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
        options.timeoutMs > DPAPI_SIGNER_TIMEOUT_MS ||
        options.maxResponseBytes !== MAX_DPAPI_IPC_RESPONSE_BYTES || options.signal.aborted) {
      throw failure();
    }
    const policy = this.policy;
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(failure()), { once: true });
    });
    let child: BridgeChild | undefined;
    let succeeded = false;
    try {
      const assemblyPath = win32.join(policy.installationDirectory, "Sigae.M3.DpapiSigner.dll");
      for (const [path, expected] of [
        [policy.executablePath, policy.executableSha256],
        [assemblyPath, policy.assemblySha256],
      ] as const) {
        const bytes = await Promise.race([this.readBinary(path, controller.signal), abortPromise]);
        if (controller.signal.aborted || bytes.byteLength === 0 ||
            bytes.byteLength > maximumBinaryBytes ||
            createHash("sha256").update(bytes).digest("hex") !== expected) throw failure();
      }
      if (controller.signal.aborted) throw failure();
      child = this.spawnProcess(policy.executablePath, ["--verified-proxy"], {
        cwd: policy.installationDirectory,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {},
      });
      const response = await this.exchangeChild(child, requestFrame, options.maxResponseBytes,
        controller.signal);
      validateDpapiSignerResponseFrame(response, request);
      succeeded = true;
      return response;
    } catch {
      throw failure();
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      controller.abort();
      if (!succeeded) child?.kill();
    }
  }

  private exchangeChild(child: BridgeChild, requestFrame: Uint8Array,
    maxResponseBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let outputLength = 0;
      let errorLength = 0;
      const output: Buffer[] = [];
      const fail = () => {
        if (settled) return;
        settled = true;
        reject(failure());
      };
      const onAbort = () => { child.kill(); fail(); };
      signal.addEventListener("abort", onAbort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        if (!Buffer.isBuffer(chunk)) { fail(); return; }
        outputLength += chunk.byteLength;
        if (outputLength > maxResponseBytes + 4) { child.kill(); fail(); return; }
        output.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (settled) return;
        errorLength += chunk.byteLength;
        if (errorLength > maximumStderrBytes) { child.kill(); fail(); }
      });
      child.stdin.on("error", fail);
      child.once("error", fail);
      child.once("close", (code: number | null) => {
        signal.removeEventListener("abort", onAbort);
        if (settled || code !== 0 || outputLength < 5) { fail(); return; }
        const frame = Buffer.concat(output, outputLength);
        const declared = frame.readUInt32BE(0);
        if (declared < 1 || declared > maxResponseBytes || declared !== frame.byteLength - 4) {
          fail(); return;
        }
        settled = true;
        resolve(frame);
      });
      if (signal.aborted) { onAbort(); return; }
      child.stdin.end(requestFrame);
    });
  }
}
