import { createHash, randomUUID } from "node:crypto";
import { ALERT_JWS_ALGORITHM, type AlertSigner } from "./alert-signer.js";
import type { LocalAlertSignerSource } from "./local-alert-signer-source.js";
import { SigningError } from "./signing-error.js";

export const DPAPI_SIGNER_PROTOCOL_VERSION = 1 as const;
export const MAX_DPAPI_SIGNING_INPUT_BYTES = 256 * 1024;
export const MAX_DPAPI_IPC_REQUEST_BYTES = 256 * 1024 + 1024;
export const MAX_DPAPI_IPC_RESPONSE_BYTES = 4096;
export const DPAPI_SIGNER_TIMEOUT_MS = 3000;
export const WINDOWS_DPAPI_SIGNER_PIPE = "\\\\.\\pipe\\siga-e-m3-signer-v1";

const kidPattern = /^[A-Za-z0-9._-]{1,128}$/u;
const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]+$/u;

export interface DpapiSignerSignRequest {
  readonly version: typeof DPAPI_SIGNER_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly operation: "sign";
  readonly alg: typeof ALERT_JWS_ALGORITHM;
  readonly kid: string;
  readonly signingInput: string;
  readonly signingInputSha256: string;
}

export interface DpapiIpcChannel {
  /** Exchanges exactly one framed request and closes on abort; implementations must not retry. */
  exchange(
    requestFrame: Uint8Array,
    options: {
      readonly timeoutMs: number;
      readonly signal: AbortSignal;
      readonly maxResponseBytes: number;
    },
  ): Promise<Uint8Array>;
}

export interface DpapiSignerExchange {
  exchange(request: DpapiSignerSignRequest, timeoutMs: number, signal?: AbortSignal): Promise<unknown>;
}

export interface DpapiSignerAuthorizationPolicy {
  readonly allowedClientSid: string;
  readonly allowedKid: string;
}

function isIndividualAccountSid(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 184) return false;
  const match = /^S-1-5-21-(0|[1-9][0-9]*)-(0|[1-9][0-9]*)-(0|[1-9][0-9]*)-([1-9][0-9]*)$/u.exec(value);
  if (!match) return false;
  return match.slice(1).every((part) => {
    const subAuthority = BigInt(part!);
    return subAuthority <= 0xffff_ffffn;
  });
}

function validKid(kid: unknown): kid is string {
  return typeof kid === "string" && kidPattern.test(kid);
}

function canonicalSegment(segment: string): boolean {
  return canonicalBase64UrlPattern.test(segment) &&
    Buffer.from(segment, "base64url").toString("base64url") === segment;
}

function parseSignatureResponse(value: unknown, request: DpapiSignerSignRequest): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Respuesta del firmador no válida.");
  }
  const response = value as Record<string, unknown>;
  const keys = Object.keys(response).sort();
  if (keys.join(",") !== "alg,kid,requestId,signature,signingInputSha256,version" ||
      response.version !== DPAPI_SIGNER_PROTOCOL_VERSION ||
      response.requestId !== request.requestId ||
      response.kid !== request.kid ||
      response.alg !== ALERT_JWS_ALGORITHM ||
      response.signingInputSha256 !== request.signingInputSha256 ||
      typeof response.signature !== "string" ||
      !canonicalSegment(response.signature) ||
      Buffer.from(response.signature, "base64url").length !== 64) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Respuesta del firmador no válida.");
  }
  return response.signature;
}

function parseStrictJson(text: string): unknown {
  const parsed = JSON.parse(text) as unknown;
  if (JSON.stringify(parsed) !== text) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Mensaje IPC no válido.");
  }
  return parsed;
}

export function validateDpapiSignerRequest(value: unknown): DpapiSignerSignRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Solicitud del firmador no válida.");
  }
  const request = value as Record<string, unknown>;
  const keys = Object.keys(request).sort();
  if (keys.join(",") !== "alg,kid,operation,requestId,signingInput,signingInputSha256,version" ||
      request.version !== DPAPI_SIGNER_PROTOCOL_VERSION ||
      request.operation !== "sign" ||
      request.alg !== ALERT_JWS_ALGORITHM ||
      !validKid(request.kid) ||
      !validRequestId(request.requestId) ||
      typeof request.signingInput !== "string" ||
      typeof request.signingInputSha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(request.signingInputSha256) ||
      !/^[\x21-\x7e]+$/u.test(request.signingInput) ||
      Buffer.byteLength(request.signingInput, "ascii") + 1 + 86 > MAX_DPAPI_SIGNING_INPUT_BYTES) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Solicitud del firmador no válida.");
  }
  const [protectedSegment, payloadSegment, ...extra] = request.signingInput.split(".");
  if (!protectedSegment || !payloadSegment || extra.length !== 0 ||
      !canonicalSegment(protectedSegment) || !canonicalSegment(payloadSegment)) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Entrada de firma no válida.");
  }
  let protectedHeader: unknown;
  try {
    const headerText = new TextDecoder("utf-8", { fatal: true })
      .decode(Buffer.from(protectedSegment, "base64url"));
    protectedHeader = parseStrictJson(headerText);
  } catch {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Cabecera de firma no válida.");
  }
  if (!protectedHeader || typeof protectedHeader !== "object" || Array.isArray(protectedHeader)) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Cabecera de firma no válida.");
  }
  const header = protectedHeader as Record<string, unknown>;
  if (Object.keys(header).sort().join(",") !== "alg,kid" ||
      header.alg !== ALERT_JWS_ALGORITHM || header.kid !== request.kid) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Cabecera de firma no válida.");
  }
  const signingInputDigest = createHash("sha256").update(request.signingInput, "ascii").digest("hex");
  if (request.signingInputSha256 !== signingInputDigest) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "La entrada de firma fue alterada.");
  }
  return Object.freeze({
    version: DPAPI_SIGNER_PROTOCOL_VERSION,
    requestId: request.requestId,
    operation: "sign",
    alg: ALERT_JWS_ALGORITHM,
    kid: request.kid,
    signingInput: request.signingInput,
    signingInputSha256: request.signingInputSha256,
  });
}

export function validateDpapiSignerRequestFrame(frame: Uint8Array): DpapiSignerSignRequest {
  if (!(frame instanceof Uint8Array) ||
      frame.byteLength < 5 || frame.byteLength > MAX_DPAPI_IPC_REQUEST_BYTES + 4) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Trama del firmador no válida.");
  }
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = buffer.readUInt32BE(0);
  if (length === 0 || length !== buffer.byteLength - 4 ||
      length > MAX_DPAPI_IPC_REQUEST_BYTES) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Trama del firmador no válida.");
  }
  try {
    const requestText = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4));
    const request = validateDpapiSignerRequest(parseStrictJson(requestText));
    if (JSON.stringify(request) !== requestText) {
      throw new SigningError("SIGNATURE_OPERATION_FAILED", "Solicitud IPC no válida.");
    }
    return request;
  } catch {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Solicitud IPC no válida.");
  }
}

export function validateDpapiSignerResponseFrame(
  frame: Uint8Array,
  request: DpapiSignerSignRequest,
): void {
  if (!(frame instanceof Uint8Array) ||
      frame.byteLength < 5 || frame.byteLength > MAX_DPAPI_IPC_RESPONSE_BYTES + 4) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Trama del firmador no válida.");
  }
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = buffer.readUInt32BE(0);
  if (length === 0 || length !== buffer.byteLength - 4 ||
      length > MAX_DPAPI_IPC_RESPONSE_BYTES) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Trama del firmador no válida.");
  }
  try {
    const responseText = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4));
    const response = parseStrictJson(responseText);
    parseSignatureResponse(response, request);
  } catch {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Respuesta IPC no válida.");
  }
}

export function authorizeDpapiSignerRequest(
  request: DpapiSignerSignRequest,
  authenticatedClientSid: string,
  policy: DpapiSignerAuthorizationPolicy,
): void {
  if (!isIndividualAccountSid(authenticatedClientSid) ||
      !isIndividualAccountSid(policy.allowedClientSid) ||
      authenticatedClientSid !== policy.allowedClientSid) {
    throw new SigningError("SIGNING_KEY_SOURCE_UNAVAILABLE",
      "La identidad del cliente del firmador no está autorizada.");
  }
  const validatedRequest = validateDpapiSignerRequest(request);
  if (validatedRequest.kid !== policy.allowedKid) {
    throw new SigningError("UNTRUSTED_KEY",
      "El identificador de clave no está autorizado para firmar.");
  }
}

function makeSigningInput(payloadBytes: Uint8Array, kid: string): string {
  const protectedHeader = Buffer.from(JSON.stringify({
    alg: ALERT_JWS_ALGORITHM,
    kid,
  }), "utf8").toString("base64url");
  const encodedPayload = Buffer.from(payloadBytes).toString("base64url");
  const signingInput = `${protectedHeader}.${encodedPayload}`;
  if (Buffer.byteLength(signingInput, "ascii") + 1 + 86 > MAX_DPAPI_SIGNING_INPUT_BYTES) {
    throw new SigningError("INVALID_COMPACT_JWS", "El contenido supera el límite de firma.");
  }
  return signingInput;
}

function frameMessage(message: Uint8Array): Uint8Array {
  const frame = Buffer.allocUnsafe(4 + message.byteLength);
  frame.writeUInt32BE(message.byteLength, 0);
  frame.set(message, 4);
  return frame;
}

function unframeMessage(frame: Uint8Array): Uint8Array {
  if (frame.byteLength < 4 || frame.byteLength > MAX_DPAPI_IPC_RESPONSE_BYTES + 4) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Respuesta del firmador fuera de límite.");
  }
  const buffer = Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = buffer.readUInt32BE(0);
  if (length > MAX_DPAPI_IPC_RESPONSE_BYTES || length !== buffer.byteLength - 4) {
    throw new SigningError("SIGNATURE_OPERATION_FAILED", "Trama del firmador no válida.");
  }
  return buffer.subarray(4);
}

export class FramedDpapiSignerExchange implements DpapiSignerExchange {
  readonly #channel: DpapiIpcChannel;
  readonly #usedRequestIds = new Set<string>();

  constructor(channel: DpapiIpcChannel) {
    this.#channel = channel;
  }

  async exchange(request: DpapiSignerSignRequest, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const validatedRequest = validateDpapiSignerRequest(request);
    const requestKey = validatedRequest.requestId.toLowerCase();
    if (this.#usedRequestIds.has(requestKey) ||
        this.#usedRequestIds.size >= 4096) {
      throw new SigningError("SIGNATURE_OPERATION_FAILED", "Solicitud de firma duplicada o fuera de límite.");
    }
    this.#usedRequestIds.add(requestKey);
    const requestBytes = Buffer.from(JSON.stringify(validatedRequest), "utf8");
    if (requestBytes.byteLength > MAX_DPAPI_IPC_REQUEST_BYTES ||
        !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        timeoutMs > DPAPI_SIGNER_TIMEOUT_MS) {
      throw new SigningError("SIGNATURE_OPERATION_FAILED", "Solicitud IPC fuera de límite.");
    }

    const abortController = new AbortController();
    let timeout: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        abortController.abort();
        reject(new Error("IPC_TIMEOUT"));
      }, timeoutMs);
    });
    let removeAbortListener: () => void = () => {};
    const abortPromise = signal ? new Promise<never>((_, reject) => {
      const onAbort = () => {
        abortController.abort();
        reject(new Error("SIGNING_ABORTED"));
      };
      removeAbortListener = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    }) : new Promise<never>(() => undefined);
    try {
      const responseFrame = await Promise.race([
        this.#channel.exchange(frameMessage(requestBytes), {
          timeoutMs,
          signal: abortController.signal,
          maxResponseBytes: MAX_DPAPI_IPC_RESPONSE_BYTES,
        }),
        timeoutPromise,
        abortPromise,
      ]);
      const responseBytes = unframeMessage(responseFrame);
      const responseText = new TextDecoder("utf-8", { fatal: true }).decode(responseBytes);
      const response = parseStrictJson(responseText);
      parseSignatureResponse(response, validatedRequest);
      return response;
    } finally {
      if (timeout) clearTimeout(timeout);
      removeAbortListener();
      abortController.abort();
    }
  }
}

export class DpapiIpcAlertSignerSource implements LocalAlertSignerSource {
  readonly #kid: string;
  readonly #exchange: DpapiSignerExchange;
  readonly #requestId: () => string;
  readonly #timeoutMs: number;
  readonly #usedRequestIds = new Set<string>();

  constructor(options: {
    readonly kid: string;
    readonly exchange: DpapiSignerExchange;
    readonly requestId?: () => string;
    readonly timeoutMs?: number;
  }) {
    if (!validKid(options.kid)) {
      throw new SigningError("INVALID_SIGNING_KEY", "El identificador de firma no es válido.");
    }
    if (!options.exchange || typeof options.exchange.exchange !== "function") {
      throw new SigningError("SIGNING_KEY_SOURCE_UNAVAILABLE",
        "El transporte del firmador no está configurado.");
    }
    const timeoutMs = options.timeoutMs ?? DPAPI_SIGNER_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DPAPI_SIGNER_TIMEOUT_MS) {
      throw new SigningError("SIGNING_KEY_SOURCE_UNAVAILABLE",
        "El tiempo límite del firmador no es válido.");
    }
    this.#kid = options.kid;
    this.#exchange = options.exchange;
    this.#requestId = options.requestId ?? randomUUID;
    this.#timeoutMs = timeoutMs;
  }

  getActiveSigner(): AlertSigner {
    return Object.freeze({
      kid: this.#kid,
      sign: async (payloadBytes: Uint8Array, signal?: AbortSignal) => {
        if (signal?.aborted) throw new SigningError("SIGNATURE_OPERATION_FAILED",
          "La operación de firma fue cancelada.");
        if (!(payloadBytes instanceof Uint8Array)) {
          throw new SigningError("INVALID_HASH_INPUT", "El contenido a firmar no es válido.");
        }
        const signingInput = makeSigningInput(payloadBytes, this.#kid);
        const request: DpapiSignerSignRequest = Object.freeze({
          version: DPAPI_SIGNER_PROTOCOL_VERSION,
          requestId: this.#requestId(),
          operation: "sign",
          alg: ALERT_JWS_ALGORITHM,
          kid: this.#kid,
          signingInput,
          signingInputSha256: createHash("sha256").update(signingInput, "ascii").digest("hex"),
        });
        if (!validRequestId(request.requestId) ||
            Buffer.byteLength(JSON.stringify(request), "utf8") > MAX_DPAPI_IPC_REQUEST_BYTES) {
          throw new SigningError("SIGNATURE_OPERATION_FAILED",
            "La solicitud al firmador supera los límites permitidos.");
        }
        const requestKey = request.requestId.toLowerCase();
        if (this.#usedRequestIds.has(requestKey) || this.#usedRequestIds.size >= 4096) {
          throw new SigningError("SIGNATURE_OPERATION_FAILED",
            "La solicitud de firma ya fue utilizada o supera el límite permitido.");
        }
        this.#usedRequestIds.add(requestKey);

        let response: unknown;
        try {
          response = await this.#exchange.exchange(request, this.#timeoutMs, signal);
        } catch {
          throw new SigningError("SIGNATURE_OPERATION_FAILED",
            "La operación de firma local no pudo completarse.");
        }
        const signature = parseSignatureResponse(response, request);
        return `${signingInput}.${signature}`;
      },
    });
  }
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
