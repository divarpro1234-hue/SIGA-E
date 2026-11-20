import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  DPAPI_SIGNER_PROTOCOL_VERSION,
  DPAPI_SIGNER_TIMEOUT_MS,
  DpapiIpcAlertSignerSource,
  FramedDpapiSignerExchange,
  MAX_DPAPI_IPC_RESPONSE_BYTES,
  authorizeDpapiSignerRequest,
  validateDpapiSignerRequestFrame,
  validateDpapiSignerRequest,
  type DpapiIpcChannel,
  type DpapiSignerSignRequest,
} from "../../src/modules/signing/dpapi-signer-ipc.js";
import { TrustedAlertSigningKeyProvider } from "../../src/modules/signing/trusted-alert-signing-key-provider.js";
import type { CryptoKey } from "jose";
import type { TrustedPublicKeyCatalog } from "../../src/modules/signing/trusted-public-keys.js";

const requestId = "2f7b2a31-667c-4b84-936c-2c190ece50a1";
const kid = "trusted-test-key";
const signature = Buffer.alloc(64).toString("base64url");

function createResponse(request: DpapiSignerSignRequest, signatureValue = signature) {
  return {
    version: DPAPI_SIGNER_PROTOCOL_VERSION,
    requestId: request.requestId,
    alg: "ES256",
    kid: request.kid,
    signingInputSha256: request.signingInputSha256,
    signature: signatureValue,
  };
}

function encodeFrame(message: Uint8Array): Uint8Array {
  const frame = Buffer.alloc(4 + message.byteLength);
  frame.writeUInt32BE(message.byteLength, 0);
  frame.set(message, 4);
  return frame;
}

function encodeJsonFrame(text: string): Uint8Array {
  return encodeFrame(new TextEncoder().encode(text));
}

function trustedCatalog(kidToTrust = kid): TrustedPublicKeyCatalog {
  const publicKey = {
    type: "public",
    extractable: false,
    algorithm: { name: "ECDSA", namedCurve: "P-256" },
    usages: ["verify"],
  } as CryptoKey;
  return { resolve: vi.fn((candidate) => candidate === kidToTrust ? publicKey : undefined) };
}

function createSource(exchange: {
  exchange(request: DpapiSignerSignRequest, timeoutMs: number): Promise<unknown>;
}, options: { keyId?: string; requestId?: () => string } = {}) {
  return new DpapiIpcAlertSignerSource({
    kid: options.keyId ?? kid,
    exchange,
    requestId: options.requestId ?? (() => requestId),
  });
}

describe("protocolo del firmador local DPAPI", () => {
  it("rechaza una fuente no configurada y límites de timeout inválidos", () => {
    expect(() => new DpapiIpcAlertSignerSource({
      kid,
      exchange: undefined as never,
    })).toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
    expect(() => new DpapiIpcAlertSignerSource({
      kid,
      exchange: { exchange: vi.fn() },
      timeoutMs: DPAPI_SIGNER_TIMEOUT_MS + 1,
    })).toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
  });

  it("construye signing input exacto y devuelve solo JWS compacto ES256", async () => {
    const exchange = {
      exchange: vi.fn(async (request: DpapiSignerSignRequest, timeoutMs: number) => {
        expect(timeoutMs).toBe(DPAPI_SIGNER_TIMEOUT_MS);
        expect(validateDpapiSignerRequest(request)).toEqual(request);
        return createResponse(request);
      }),
    };
    const signer = createSource(exchange).getActiveSigner();
    const payload = new TextEncoder().encode('{ "notice":"SIMULACRO" }\n');

    const compact = await signer.sign(payload);
    const [headerSegment, payloadSegment, signatureSegment] = compact.split(".");

    expect(compact.split(".")).toHaveLength(3);
    expect(JSON.parse(Buffer.from(headerSegment!, "base64url").toString("utf8"))).toEqual({
      alg: "ES256",
      kid,
    });
    expect(Buffer.from(payloadSegment!, "base64url")).toEqual(Buffer.from(payload));
    expect(Buffer.from(signatureSegment!, "base64url")).toHaveLength(64);
    const request = exchange.exchange.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(request).not.toHaveProperty("privateKey");
    expect(request).not.toHaveProperty("pkcs8");
    expect(request).not.toHaveProperty("jwk");
  });

  it("rechaza kid que no figura en el catálogo público confiable", () => {
    const source = createSource({
      exchange: vi.fn(),
    }, { keyId: "unknown-test-key" });
    const provider = new TrustedAlertSigningKeyProvider(source, trustedCatalog());

    expect(() => provider.getActiveSigner()).toThrowError(
      expect.objectContaining({ code: "UNTRUSTED_KEY" }),
    );
  });

  it("rechaza algoritmo distinto, respuesta de otra solicitud y respuesta con campos extra", async () => {
    for (const response of [
      (request: DpapiSignerSignRequest) => ({ ...createResponse(request), alg: "ES384" }),
      (request: DpapiSignerSignRequest) => ({ ...createResponse(request), requestId: "2f7b2a31-667c-4b84-936c-2c190ece50a2" }),
      (request: DpapiSignerSignRequest) => ({ ...createResponse(request), privateKey: "secret" }),
    ]) {
      const signer = createSource({
        exchange: async (request) => response(request),
      }).getActiveSigner();
      await expect(signer.sign(new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
        code: "SIGNATURE_OPERATION_FAILED",
      });
    }
  });

  it("rechaza JSON IPC no canónico y propiedades duplicadas", async () => {
    const signingInput =
      `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
    const request = {
      version: DPAPI_SIGNER_PROTOCOL_VERSION,
      requestId,
      operation: "sign",
      alg: "ES256",
      kid,
      signingInput,
      signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
    } satisfies DpapiSignerSignRequest;
    const requestText = JSON.stringify(request);
    const duplicateRequest = requestText.replace(
      '"kid":"trusted-test-key"',
      '"kid":"trusted-test-key","kid":"trusted-test-key"',
    );

    expect(() => validateDpapiSignerRequestFrame(encodeJsonFrame(duplicateRequest)))
      .toThrowError(expect.objectContaining({ code: "SIGNATURE_OPERATION_FAILED" }));
    expect(() => validateDpapiSignerRequestFrame(encodeJsonFrame(` ${requestText}`)))
      .toThrowError(expect.objectContaining({ code: "SIGNATURE_OPERATION_FAILED" }));
    expect(validateDpapiSignerRequestFrame(encodeJsonFrame(requestText))).toEqual(request);

    const duplicateResponse = JSON.stringify(createResponse(request)).replace(
      `"requestId":"${requestId}"`,
      `"requestId":"${requestId}","requestId":"${requestId}"`,
    );
    const channel: DpapiIpcChannel = {
      exchange: vi.fn(async () => encodeJsonFrame(duplicateResponse)),
    };
    await expect(new FramedDpapiSignerExchange(channel).exchange(request, 100))
      .rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
  });

  it("rechaza signing input alterado, algoritmo, kid y estructura inesperada", () => {
    const input = `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
    const digest = createHash("sha256").update(input, "ascii").digest("hex");
    const validRequest = {
      version: DPAPI_SIGNER_PROTOCOL_VERSION,
      requestId,
      operation: "sign",
      alg: "ES256",
      kid,
      signingInput: input,
      signingInputSha256: digest,
    };

    expect(validateDpapiSignerRequest(validRequest)).toMatchObject({ kid, alg: "ES256" });
    expect(() => validateDpapiSignerRequest({
      ...validRequest,
      signingInput: `${input}A`,
    })).toThrowError(expect.objectContaining({ code: "SIGNATURE_OPERATION_FAILED" }));
    expect(() => validateDpapiSignerRequest({ ...validRequest, alg: "ES384" }))
      .toThrowError(expect.objectContaining({ code: "SIGNATURE_OPERATION_FAILED" }));
    expect(() => validateDpapiSignerRequest({ ...validRequest, kid: "other-key" }))
      .toThrowError(expect.objectContaining({ code: "SIGNATURE_OPERATION_FAILED" }));
    expect(() => validateDpapiSignerRequest({ ...validRequest, extra: true }))
      .toThrowError(expect.objectContaining({ code: "SIGNATURE_OPERATION_FAILED" }));
  });

  it("rechaza identidad Windows no permitida y kid fuera de la política del firmador", () => {
    const signingInput = `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
    const request = validateDpapiSignerRequest({
      version: DPAPI_SIGNER_PROTOCOL_VERSION,
      requestId,
      operation: "sign",
      alg: "ES256",
      kid,
      signingInput,
      signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
    });
    const policy = { allowedClientSid: "S-1-5-21-1001-1002-1003-1001", allowedKid: kid };

    expect(() => authorizeDpapiSignerRequest(request, "S-1-5-21-1001-1002-1003-1002", policy))
      .toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
    expect(() => authorizeDpapiSignerRequest(request, "S-1-5-11", policy))
      .toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
    expect(() => authorizeDpapiSignerRequest(request,
      "S-1-5-21-999999999999999999999-1002-1003-1001", policy))
      .toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
    expect(() => authorizeDpapiSignerRequest(request, policy.allowedClientSid, {
      ...policy, allowedClientSid: "S-1-5-11",
    })).toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
    expect(() => authorizeDpapiSignerRequest(request, "not-a-sid", policy))
      .toThrowError(expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }));
    expect(() => authorizeDpapiSignerRequest(request, policy.allowedClientSid, {
      ...policy,
      allowedKid: "another-approved-key",
    })).toThrowError(expect.objectContaining({ code: "UNTRUSTED_KEY" }));
    expect(() => authorizeDpapiSignerRequest(request, policy.allowedClientSid, policy)).not.toThrow();
  });

  it("framing vincula la respuesta a la solicitud y limita su tamaño", async () => {
    const channel: DpapiIpcChannel = {
      exchange: vi.fn(async (frame) => {
        const buffer = Buffer.from(frame);
        const requestLength = buffer.readUInt32BE(0);
        expect(requestLength).toBe(buffer.byteLength - 4);
        const request = validateDpapiSignerRequest(
          JSON.parse(buffer.subarray(4).toString("utf8")) as unknown,
        );
        return encodeFrame(new TextEncoder().encode(JSON.stringify(createResponse(request))));
      }),
    };
    const exchange = new FramedDpapiSignerExchange(channel);
    const signingInput = `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
    const request = {
      version: DPAPI_SIGNER_PROTOCOL_VERSION,
      requestId,
      operation: "sign",
      alg: "ES256",
      kid,
      signingInput,
      signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
    } satisfies DpapiSignerSignRequest;

    await expect(exchange.exchange(request, 100)).resolves.toEqual(createResponse(request));
    expect(channel.exchange).toHaveBeenCalledOnce();
    expect(vi.mocked(channel.exchange).mock.calls[0]?.[1].maxResponseBytes)
      .toBe(MAX_DPAPI_IPC_RESPONSE_BYTES);
  });

  it("rechaza replay del mismo UUID con capitalización distinta", async () => {
    const signingInput =
      `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
    const upperRequest = {
      version: DPAPI_SIGNER_PROTOCOL_VERSION,
      requestId: requestId.toUpperCase(),
      operation: "sign",
      alg: "ES256",
      kid,
      signingInput,
      signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
    } satisfies DpapiSignerSignRequest;
    const channel: DpapiIpcChannel = {
      exchange: vi.fn(async () => encodeFrame(new TextEncoder().encode(
        JSON.stringify(createResponse(upperRequest)),
      ))),
    };
    const exchange = new FramedDpapiSignerExchange(channel);

    await expect(exchange.exchange(upperRequest, 100)).resolves.toEqual(
      createResponse(upperRequest),
    );
    await expect(exchange.exchange({ ...upperRequest, requestId }, 100))
      .rejects.toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
    expect(channel.exchange).toHaveBeenCalledOnce();
  });

  it("falla cerrado en timeout, desconexión y error DPAPI sin reintentar ni filtrar detalles", async () => {
    vi.useFakeTimers();
    try {
      const timeoutChannel: DpapiIpcChannel = {
        exchange: vi.fn((_frame, _options) => new Promise<Uint8Array>(() => {})),
      };
      const framed = new FramedDpapiSignerExchange(timeoutChannel);
      const request = {
        version: DPAPI_SIGNER_PROTOCOL_VERSION,
        requestId,
        operation: "sign",
        alg: "ES256",
        kid,
        signingInput: "eyJhbGciOiJFUzI1NiIsImtpZCI6InRydXN0ZWQtdGVzdC1rZXkifQ.AQ",
        signingInputSha256: "0".repeat(64),
      } satisfies DpapiSignerSignRequest;
      const signingInput = `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
      const validRequest = {
        ...request,
        signingInput,
        signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
      };
      const timed = framed.exchange(validRequest, 25);
      const timedExpectation = expect(timed).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(25);
      await timedExpectation;
      expect(timeoutChannel.exchange).toHaveBeenCalledOnce();
      expect(vi.mocked(timeoutChannel.exchange).mock.calls[0]?.[1].signal.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }

    for (const failure of ["pipe disconnected", "DPAPI secret buffer failed"]) {
      const signer = createSource({
        exchange: async () => { throw new Error(failure); },
      }).getActiveSigner();
      try {
        await signer.sign(new Uint8Array([1]));
        throw new Error("expected sanitized transport failure");
      } catch (error) {
        expect(error).toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
        expect(String(error)).not.toContain(failure);
      }
    }
  });

  it("rechaza mensajes de entrada y respuesta fuera del límite", async () => {
    const oversizedSource = createSource({ exchange: vi.fn() });
    await expect(oversizedSource.getActiveSigner().sign(
      new Uint8Array(MAX_DPAPI_IPC_RESPONSE_BYTES * 1024),
    )).rejects.toMatchObject({ code: "INVALID_COMPACT_JWS" });

    const responseFrame = new Uint8Array(MAX_DPAPI_IPC_RESPONSE_BYTES + 5);
    responseFrame.set([0, 0, 16, 1], 0);
    const channel: DpapiIpcChannel = {
      exchange: vi.fn(async () => responseFrame),
    };
    const exchange = new FramedDpapiSignerExchange(channel);
    const request = {
      version: DPAPI_SIGNER_PROTOCOL_VERSION,
      requestId,
      operation: "sign",
      alg: "ES256",
      kid,
      signingInput: "header.payload",
      signingInputSha256: "0".repeat(64),
    } satisfies DpapiSignerSignRequest;
    const signingInput = `${Buffer.from(JSON.stringify({ alg: "ES256", kid })).toString("base64url")}.AQ`;
    const validRequest = {
      ...request,
      signingInput,
      signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
    };
    await expect(exchange.exchange(validRequest, 100)).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
  });

  it("rechaza respuesta que no devuelve exactamente una firma ES256 de 64 bytes", async () => {
    const signer = createSource({
      exchange: async (request) => createResponse(request, Buffer.alloc(63).toString("base64url")),
    }).getActiveSigner();
    await expect(signer.sign(new Uint8Array([1]))).rejects.toMatchObject({
      code: "SIGNATURE_OPERATION_FAILED",
    });
  });
});
