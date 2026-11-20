import { createConnection, type Socket } from "node:net";
import {
  DPAPI_SIGNER_TIMEOUT_MS,
  MAX_DPAPI_IPC_REQUEST_BYTES,
  MAX_DPAPI_IPC_RESPONSE_BYTES,
  WINDOWS_DPAPI_SIGNER_PIPE,
  type DpapiIpcChannel,
} from "./dpapi-signer-ipc.js";
import type { DotnetVerifierBridgeChannel } from "./dotnet-verifier-bridge-channel.js";
import { SigningError } from "./signing-error.js";

const failed = () => new SigningError("SIGNATURE_OPERATION_FAILED", "Canal local de firma no disponible.");

export type PipeConnector = (path: string) => Socket;
export type PipeServerVerifier = (socket: Socket) => Promise<boolean>;
export const nodePipeConnector: PipeConnector = (path) => createConnection({ path });

/** One connection, one frame. A verifier must attest the connected server before any write. */
export class BoundedDpapiPipeChannel implements DpapiIpcChannel {
  constructor(
    private readonly connect: PipeConnector,
    private readonly verifyServer: PipeServerVerifier,
    private readonly path = WINDOWS_DPAPI_SIGNER_PIPE,
  ) {
    if (path !== WINDOWS_DPAPI_SIGNER_PIPE) throw failed();
  }

  async exchange(requestFrame: Uint8Array, options: {
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly maxResponseBytes: number;
  }): Promise<Uint8Array> {
    if (!(requestFrame instanceof Uint8Array) || requestFrame.byteLength < 5 ||
        requestFrame.byteLength > MAX_DPAPI_IPC_REQUEST_BYTES + 4 ||
        Buffer.from(requestFrame).readUInt32BE(0) !== requestFrame.byteLength - 4 ||
        !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 ||
        options.timeoutMs > DPAPI_SIGNER_TIMEOUT_MS ||
        options.maxResponseBytes !== MAX_DPAPI_IPC_RESPONSE_BYTES || options.signal.aborted) {
      throw failed();
    }

    let socket: Socket;
    try { socket = this.connect(this.path); }
    catch { throw failed(); }
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      let authenticated = false;
      let written = false;
      let expectedLength: number | undefined;
      let receivedLength = 0;
      const chunks: Buffer[] = [];
      const finish = (result?: Uint8Array) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener("abort", onAbort);
        socket.removeAllListeners("connect");
        socket.removeAllListeners("data");
        socket.removeAllListeners("error");
        socket.removeAllListeners("end");
        socket.removeAllListeners("close");
        socket.destroy();
        if (result) resolve(result);
        else reject(failed());
      };
      const onAbort = () => finish();
      const timer = setTimeout(() => finish(), options.timeoutMs);
      options.signal.addEventListener("abort", onAbort, { once: true });
      socket.once("connect", () => {
        void Promise.resolve().then(() => this.verifyServer(socket)).then((valid) => {
          if (settled) return;
          if (valid !== true) { finish(); return; }
          authenticated = true;
          written = true;
          try {
            socket.write(requestFrame, (error?: Error | null) => {
              if (error) finish();
            });
          } catch {
            finish();
          }
        }).catch(() => finish());
      });
      socket.on("data", (chunk: Buffer) => {
        if (!authenticated || !written || settled || !Buffer.isBuffer(chunk)) { finish(); return; }
        receivedLength += chunk.byteLength;
        if (receivedLength > options.maxResponseBytes + 4) { finish(); return; }
        chunks.push(chunk);
        const response = Buffer.concat(chunks, receivedLength);
        if (response.byteLength >= 4 && expectedLength === undefined) {
          expectedLength = response.readUInt32BE(0);
          if (expectedLength < 1 || expectedLength > options.maxResponseBytes) { finish(); return; }
        }
        if (expectedLength !== undefined) {
          if (response.byteLength > expectedLength + 4) { finish(); return; }
        }
      });
      socket.once("error", () => finish());
      socket.once("end", () => {
        const response = Buffer.concat(chunks, receivedLength);
        if (expectedLength !== undefined && response.byteLength === expectedLength + 4)
          finish(response);
        else finish();
      });
      socket.once("close", () => finish());
      if (options.signal.aborted) finish();
    });
  }
}

/** The bridge may be supplied only by an explicitly configured trusted-policy composition. */
export class WindowsDpapiNamedPipeChannel implements DpapiIpcChannel {
  constructor(private readonly verifiedBridge?: DotnetVerifierBridgeChannel) {}

  async exchange(requestFrame: Uint8Array, options: {
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
    readonly maxResponseBytes: number;
  }): Promise<Uint8Array> {
    if (process.platform !== "win32" || !this.verifiedBridge) throw failed();
    try {
      return await this.verifiedBridge.exchange(requestFrame, options);
    } catch {
      throw failed();
    }
  }
}
