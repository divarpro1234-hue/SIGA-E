import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import type { Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
import {
  DpapiIpcAlertSignerSource, FramedDpapiSignerExchange,
  MAX_DPAPI_IPC_RESPONSE_BYTES, WINDOWS_DPAPI_SIGNER_PIPE,
  authorizeDpapiSignerRequest, validateDpapiSignerRequest, type DpapiSignerSignRequest,
} from "../../src/modules/signing/dpapi-signer-ipc.js";
import {
  BoundedDpapiPipeChannel, WindowsDpapiNamedPipeChannel,
} from "../../src/modules/signing/windows-dpapi-pipe-channel.js";

const fixture = JSON.parse(readFileSync(new URL(
  "../../m3-dpapi-signer/protocol-fixture.json", import.meta.url,
), "utf8")) as { request: DpapiSignerSignRequest; response: Record<string, unknown> };

function frame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const result = Buffer.alloc(body.length + 4);
  result.writeUInt32BE(body.length, 0);
  body.copy(result, 4);
  return result;
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  writes: Buffer[] = [];
  onWrite?: () => void;
  responseBeforeWriteCallback = false;

  write(value: Uint8Array, callback: (error?: Error) => void): boolean {
    this.writes.push(Buffer.from(value));
    if (this.responseBeforeWriteCallback) this.onWrite?.();
    queueMicrotask(() => {
      callback();
      if (!this.responseBeforeWriteCallback) this.onWrite?.();
    });
    return true;
  }

  destroy(): this {
    this.destroyed = true;
    this.emit("close");
    return this;
  }
}

function harness(verified: boolean | Promise<boolean> = true) {
  const socket = new FakeSocket();
  const connect = vi.fn((_path: string) => {
    queueMicrotask(() => socket.emit("connect"));
    return socket as unknown as Socket;
  });
  const verifyServer = vi.fn(async () => verified);
  const channel = new BoundedDpapiPipeChannel(connect, verifyServer);
  const options = {
    timeoutMs: 50,
    signal: new AbortController().signal,
    maxResponseBytes: MAX_DPAPI_IPC_RESPONSE_BYTES,
  };
  return { socket, connect, verifyServer, channel, options };
}

describe("contrato C# y transporte IPC M3 offline", () => {
  it("comparte el fixture público v1 con C#: JSON, SHA-256, ES256, kid y respuesta", async () => {
    expect(validateDpapiSignerRequest(fixture.request)).toEqual(fixture.request);
    const source = new DpapiIpcAlertSignerSource({
      kid: fixture.request.kid,
      requestId: () => fixture.request.requestId,
      exchange: new FramedDpapiSignerExchange({
        exchange: vi.fn(async (requestFrame) => {
          expect(JSON.parse(Buffer.from(requestFrame).subarray(4).toString("utf8")))
            .toEqual(fixture.request);
          return frame(fixture.response);
        }),
      }),
    });
    const jws = await source.getActiveSigner().sign(Buffer.from([1]));
    expect(jws).toBe(`${fixture.request.signingInput}.${fixture.response.signature}`);
  });

  it("rechaza cambios del fixture en versión, kid, hash, UUID y cabecera protegida", () => {
    const mutatedHeader = Buffer.from(JSON.stringify({ alg: "ES384", kid: fixture.request.kid }))
      .toString("base64url");
    const variants = [
      { ...fixture.request, version: 2 },
      { ...fixture.request, kid: "another-kid" },
      { ...fixture.request, signingInputSha256: "0".repeat(64) },
      { ...fixture.request, requestId: "invalid" },
      { ...fixture.request, signingInput: `${mutatedHeader}.AQ` },
    ];
    for (const variant of variants) expect(() => validateDpapiSignerRequest(variant)).toThrow();
    expect(() => authorizeDpapiSignerRequest(fixture.request, "S-1-5-21-1001-1002-1003-1002", {
      allowedClientSid: "S-1-5-21-1001-1002-1003-1001", allowedKid: fixture.request.kid,
    })).toThrow();
  });

  it("autentica antes de escribir, recibe una sola trama fragmentada y cierra", async () => {
    const test = harness();
    const response = frame(fixture.response);
    test.socket.onWrite = () => {
      test.socket.emit("data", response.subarray(0, 2));
      test.socket.emit("data", response.subarray(2, 7));
      test.socket.emit("data", response.subarray(7));
      test.socket.emit("end");
    };
    const result = await test.channel.exchange(frame(fixture.request), test.options);
    expect(Buffer.from(result)).toEqual(response);
    expect(test.connect).toHaveBeenCalledOnce();
    expect(test.connect).toHaveBeenCalledWith(WINDOWS_DPAPI_SIGNER_PIPE);
    expect(test.verifyServer).toHaveBeenCalledOnce();
    expect(test.socket.writes).toHaveLength(1);
    expect(test.socket.destroyed).toBe(true);
  });

  it("acepta respuesta inmediata del servidor tras la escritura autenticada", async () => {
    const test = harness();
    test.socket.responseBeforeWriteCallback = true;
    test.socket.onWrite = () => {
      test.socket.emit("data", frame(fixture.response));
      test.socket.emit("end");
    };

    await expect(test.channel.exchange(frame(fixture.request), test.options))
      .resolves.toEqual(frame(fixture.response));
    expect(test.socket.writes).toHaveLength(1);
  });

  it("rechaza servidor impostor antes de enviar la solicitud", async () => {
    const test = harness(false);
    await expect(test.channel.exchange(frame(fixture.request), test.options)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(test.socket.writes).toHaveLength(0);
    expect(test.socket.destroyed).toBe(true);
  });

  it("rechaza bytes sobrantes después de una trama declarada completa", async () => {
    const test = harness();
    test.socket.onWrite = () => {
      test.socket.emit("data", frame(fixture.response));
      test.socket.emit("data", Buffer.from([0]));
      test.socket.emit("end");
    };
    await expect(test.channel.exchange(frame(fixture.request), test.options)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
  });

  it.each(["truncated", "oversized", "disconnected"] as const)(
    "rechaza respuesta %s y cierra sin reintento", async (caseName) => {
      const test = harness();
      test.socket.onWrite = () => {
        if (caseName === "truncated") {
          test.socket.emit("data", frame(fixture.response).subarray(0, 8));
          test.socket.emit("end");
        } else if (caseName === "oversized") {
          test.socket.emit("data", Buffer.from([0, 0, 16, 1]));
        } else test.socket.emit("close");
      };
      await expect(test.channel.exchange(frame(fixture.request), test.options)).rejects.toMatchObject({
        code: "SIGNATURE_OPERATION_FAILED",
      });
      expect(test.connect).toHaveBeenCalledOnce();
      expect(test.socket.destroyed).toBe(true);
    },
  );

  it("bloquea timeout y cancelación sin segunda conexión", async () => {
    const timed = harness(new Promise<boolean>(() => {}));
    await expect(timed.channel.exchange(frame(fixture.request), {
      ...timed.options, timeoutMs: 5,
    })).rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
    expect(timed.socket.writes).toHaveLength(0);
    expect(timed.connect).toHaveBeenCalledOnce();

    const aborted = harness();
    const controller = new AbortController();
    controller.abort();
    await expect(aborted.channel.exchange(frame(fixture.request), {
      ...aborted.options, signal: controller.signal,
    })).rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
    expect(aborted.connect).not.toHaveBeenCalled();
  });

  it("rechaza una solicitud de más del límite antes de conectar", async () => {
    const test = harness();
    const overlong = Buffer.alloc(256 * 1024 + 1029);
    await expect(test.channel.exchange(overlong, test.options)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(test.connect).not.toHaveBeenCalled();
  });

  it("rechaza solicitud duplicada antes de abrir otra conexión", async () => {
    const channel = { exchange: vi.fn(async () => frame(fixture.response)) };
    const exchange = new FramedDpapiSignerExchange(channel);
    await expect(exchange.exchange(fixture.request, 50)).resolves.toEqual(fixture.response);
    await expect(exchange.exchange(fixture.request, 50)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(channel.exchange).toHaveBeenCalledOnce();
  });

  it("no reutiliza un requestId aunque se inyecte otro exchange", async () => {
    const exchange = { exchange: vi.fn(async () => fixture.response) };
    const source = new DpapiIpcAlertSignerSource({
      kid: fixture.request.kid,
      requestId: () => fixture.request.requestId,
      exchange,
    });
    await expect(source.getActiveSigner().sign(Buffer.from([1]))).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/u);
    await expect(source.getActiveSigner().sign(Buffer.from([1]))).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
    expect(exchange.exchange).toHaveBeenCalledOnce();
  });

  it("mantiene bloqueado el canal operativo mientras falta atestación Windows", async () => {
    const channel = new WindowsDpapiNamedPipeChannel();
    await expect(channel.exchange(new Uint8Array(), {
      timeoutMs: 1,
      signal: new AbortController().signal,
      maxResponseBytes: MAX_DPAPI_IPC_RESPONSE_BYTES,
    })).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
  });
});
