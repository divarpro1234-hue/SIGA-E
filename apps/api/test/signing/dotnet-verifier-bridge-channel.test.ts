import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  DpapiIpcAlertSignerSource, FramedDpapiSignerExchange,
  MAX_DPAPI_IPC_RESPONSE_BYTES,
} from "../../src/modules/signing/dpapi-signer-ipc.js";
import {
  DotnetVerifierBridgeChannel, type TrustedDotnetVerifierPolicy,
} from "../../src/modules/signing/dotnet-verifier-bridge-channel.js";
import { WindowsDpapiNamedPipeChannel } from "../../src/modules/signing/windows-dpapi-pipe-channel.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../m3-dpapi-signer/protocol-fixture.json", import.meta.url,
), "utf8")) as { request: Record<string, unknown>; response: Record<string, unknown> };
const exe = Buffer.from("public synthetic helper image");
const dll = Buffer.from("public synthetic helper assembly");
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const policy: TrustedDotnetVerifierPolicy = {
  installationDirectory: "C:\\Protected\\SIGAE",
  executablePath: "C:\\Protected\\SIGAE\\Sigae.M3.DpapiSigner.exe",
  executableSha256: sha(exe),
  assemblySha256: sha(dll),
};

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

function frameText(text: string): Buffer {
  const body = Buffer.from(text);
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  sent: Buffer[] = [];
  kill = vi.fn(() => true);

  constructor(private readonly reply?: Buffer, private readonly code = 0) {
    super();
    this.stdin.on("data", (chunk: Buffer) => this.sent.push(Buffer.from(chunk)));
    this.stdin.on("end", () => {
      if (this.reply) queueMicrotask(() => {
        this.stdout.end(this.reply);
        this.stderr.end();
        this.emit("close", this.code);
      });
    });
  }
}

function harness(options: {
  trusted?: TrustedDotnetVerifierPolicy;
  reply?: Buffer;
  exitCode?: number;
  readBinary?: (path: string, signal: AbortSignal) => Promise<Uint8Array>;
  spawnFailure?: boolean;
} = {}) {
  const child = new FakeChild(options.reply === undefined ? frame(fixture.response) : options.reply,
    options.exitCode ?? 0);
  const spawnProcess = vi.fn(() => {
    if (options.spawnFailure) throw new Error("private path detail");
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const readBinary = vi.fn(options.readBinary ?? (async (path: string) =>
    path.toLowerCase().endsWith(".exe") ? exe : dll));
  const bridge = new DotnetVerifierBridgeChannel(
    options.trusted === undefined ? policy : options.trusted, spawnProcess, readBinary,
  );
  const request = frame(fixture.request);
  const transportOptions = {
    timeoutMs: 100, signal: new AbortController().signal,
    maxResponseBytes: MAX_DPAPI_IPC_RESPONSE_BYTES,
  };
  return { bridge, child, spawnProcess, readBinary, request, transportOptions };
}

describe("puente Node a cliente verificador .NET, solo con dobles", () => {
  it("verifica exe y DLL antes de spawn y usa una sola trama por stdin/stdout", async () => {
    const test = harness();
    const response = await test.bridge.exchange(test.request, test.transportOptions);
    expect(Buffer.from(response)).toEqual(frame(fixture.response));
    expect(test.readBinary).toHaveBeenCalledTimes(2);
    expect(test.spawnProcess).toHaveBeenCalledOnce();
    expect(test.spawnProcess).toHaveBeenCalledWith(policy.executablePath,
      ["--verified-proxy"], expect.objectContaining({
        shell: false, windowsHide: true, detached: false,
        cwd: policy.installationDirectory, env: {},
        stdio: ["pipe", "pipe", "pipe"],
      }));
    expect(Buffer.concat(test.child.sent)).toEqual(test.request);
  });

  it("conecta el wrapper Windows solo al puente que valida política y proceso", async () => {
    const test = harness();
    const channel = new WindowsDpapiNamedPipeChannel(test.bridge);
    if (process.platform !== "win32") {
      await expect(channel.exchange(test.request, test.transportOptions))
        .rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
      expect(test.spawnProcess).not.toHaveBeenCalled();
      return;
    }

    await expect(channel.exchange(test.request, test.transportOptions))
      .resolves.toEqual(frame(fixture.response));
    expect(test.spawnProcess).toHaveBeenCalledOnce();
  });

  it("se adapta a LocalAlertSignerSource sin cambiar el contrato JWS M3", async () => {
    const test = harness();
    const source = new DpapiIpcAlertSignerSource({
      kid: "trusted-test-key",
      requestId: () => String(fixture.request.requestId),
      exchange: new FramedDpapiSignerExchange(test.bridge),
    });
    const compact = await source.getActiveSigner().sign(Buffer.from([1]));
    expect(compact).toBe(`${fixture.request.signingInput}.${fixture.response.signature}`);
    expect(test.spawnProcess).toHaveBeenCalledOnce();
  });

  it("rechaza política ausente, incompleta o ruta no aprobada antes de spawn", async () => {
    const missing = harness();
    const noPolicy = new DotnetVerifierBridgeChannel(undefined, missing.spawnProcess,
      missing.readBinary);
    await expect(noPolicy.exchange(missing.request, missing.transportOptions)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    for (const trusted of [
      { ...policy, executablePath: "C:\\Temp\\evil.exe" },
      { ...policy, executableSha256: "" },
      { ...policy, installationDirectory: "relative" },
    ]) {
      const test = harness({ trusted });
      await expect(test.bridge.exchange(test.request, test.transportOptions)).rejects.toMatchObject({
        code: "SIGNATURE_OPERATION_FAILED",
      });
      expect(test.spawnProcess).not.toHaveBeenCalled();
    }
    expect(missing.spawnProcess).not.toHaveBeenCalled();
  });

  it("congela una copia de la política inyectada frente a mutación posterior", async () => {
    const mutable = { ...policy };
    const test = harness({ trusted: mutable });
    mutable.executablePath = "C:\\Temp\\evil.exe";
    await expect(test.bridge.exchange(test.request, test.transportOptions))
      .resolves.toEqual(frame(fixture.response));
    expect(test.spawnProcess).toHaveBeenCalledWith(policy.executablePath,
      ["--verified-proxy"], expect.anything());
  });

  it("rechaza binario discrepante e inexistente sin iniciar proceso", async () => {
    const wrong = harness({ readBinary: async () => Buffer.from("wrong") });
    await expect(wrong.bridge.exchange(wrong.request, wrong.transportOptions)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(wrong.spawnProcess).not.toHaveBeenCalled();
    const absent = harness({ readBinary: async () => { throw new Error("private path detail"); } });
    await expect(absent.bridge.exchange(absent.request, absent.transportOptions)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(absent.spawnProcess).not.toHaveBeenCalled();
  });

  it("sanitiza fallo de spawn y no envía ni reintenta", async () => {
    const test = harness({ spawnFailure: true });
    try {
      await test.bridge.exchange(test.request, test.transportOptions);
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
      expect(String(error)).not.toContain("private path detail");
    }
    expect(test.spawnProcess).toHaveBeenCalledOnce();
    expect(test.child.sent).toHaveLength(0);
  });

  it("rechaza solicitud sobredimensionada y protocolo incompatible sin spawn", async () => {
    const test = harness();
    const duplicateField = frameText(JSON.stringify(fixture.request).replace(
      '"kid":"trusted-test-key"',
      '"kid":"trusted-test-key","kid":"trusted-test-key"',
    ));
    for (const request of [
      Buffer.alloc(256 * 1024 + 1029),
      Buffer.from([0, 0, 0, 4, 1]),
      duplicateField,
    ]) {
      await expect(test.bridge.exchange(request, test.transportOptions)).rejects.toMatchObject({
        code: "SIGNATURE_OPERATION_FAILED",
      });
    }
    expect(test.spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["corrupta", Buffer.from([0, 0, 0, 9, 1])],
    ["demasiado grande", Buffer.alloc(MAX_DPAPI_IPC_RESPONSE_BYTES + 5)],
  ] as const)("rechaza respuesta %s", async (_label, reply) => {
    const test = harness({ reply });
    await expect(test.bridge.exchange(test.request, test.transportOptions)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(test.spawnProcess).toHaveBeenCalledOnce();
  });

  it("rechaza fin inesperado y timeout sin reintentar", async () => {
    const exited = harness({ exitCode: 1 });
    await expect(exited.bridge.exchange(exited.request, exited.transportOptions)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    const timed = harness();
    // A child that never finishes must be terminated by the bridge deadline.
    timed.child.stdin.removeAllListeners("end");
    await expect(timed.bridge.exchange(timed.request, {
      ...timed.transportOptions, timeoutMs: 5,
    })).rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
    expect(timed.child.kill).toHaveBeenCalled();
    expect(timed.spawnProcess).toHaveBeenCalledOnce();
    const stalledVerification = harness({
      readBinary: async () => new Promise<Uint8Array>(() => {}),
    });
    await expect(stalledVerification.bridge.exchange(stalledVerification.request, {
      ...stalledVerification.transportOptions, timeoutMs: 5,
    })).rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
    expect(stalledVerification.spawnProcess).not.toHaveBeenCalled();
  });

  it("rechaza respuesta de otro requestId desde el contrato M3 sin nueva firma", async () => {
    const test = harness({ reply: frame({ ...fixture.response, requestId: "other-request-id" }) });
    const source = new DpapiIpcAlertSignerSource({
      kid: "trusted-test-key",
      requestId: () => String(fixture.request.requestId),
      exchange: new FramedDpapiSignerExchange(test.bridge),
    });
    await expect(source.getActiveSigner().sign(Buffer.from([1]))).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(test.spawnProcess).toHaveBeenCalledOnce();
  });
});
