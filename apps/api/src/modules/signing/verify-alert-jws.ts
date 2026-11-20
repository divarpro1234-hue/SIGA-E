import { compactVerify, decodeProtectedHeader } from "jose";

import { ALERT_JWS_ALGORITHM } from "./alert-signer.js";
import { SigningError } from "./signing-error.js";
import type { TrustedPublicKeyCatalog } from "./trusted-public-keys.js";

const compactJwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const allowedProtectedHeaderNames = new Set(["alg", "kid"]);
const maxCompactJwsLength = 256 * 1024;

function isCanonicalBase64Url(segment: string): boolean {
  return Buffer.from(segment, "base64url").toString("base64url") === segment;
}

export interface VerifiedAlertJws {
  readonly payloadBytes: Uint8Array;
  readonly alg: typeof ALERT_JWS_ALGORITHM;
  readonly kid: string;
}

export async function verifyAlertJws(
  jwsCompact: string,
  trustedKeys: TrustedPublicKeyCatalog,
): Promise<VerifiedAlertJws> {
  if (typeof jwsCompact !== "string" || jwsCompact.length > maxCompactJwsLength ||
      !compactJwsPattern.test(jwsCompact)) {
    throw new SigningError(
      "INVALID_COMPACT_JWS",
      "El JWS debe tener tres segmentos base64url no vacíos y no superar el tamaño permitido.",
    );
  }
  const [protectedSegment, payloadSegment, signatureSegment] = jwsCompact.split(".");
  if (!protectedSegment || !payloadSegment || !signatureSegment ||
      !isCanonicalBase64Url(protectedSegment) || !isCanonicalBase64Url(payloadSegment) ||
      !isCanonicalBase64Url(signatureSegment)) {
    throw new SigningError(
      "INVALID_COMPACT_JWS",
      "Los segmentos JWS deben usar Base64URL canónico.",
    );
  }

  let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
  try {
    protectedHeader = decodeProtectedHeader(jwsCompact);
  } catch {
    throw new SigningError("INVALID_PROTECTED_HEADER", "La cabecera protegida no es válida.");
  }

  if (
    protectedHeader.alg !== ALERT_JWS_ALGORITHM ||
    typeof protectedHeader.kid !== "string" ||
    protectedHeader.kid.length === 0 ||
    Object.keys(protectedHeader).some((name) => !allowedProtectedHeaderNames.has(name))
  ) {
    throw new SigningError(
      "INVALID_PROTECTED_HEADER",
      "La cabecera protegida debe contener únicamente alg=ES256 y un kid confiable.",
    );
  }
  if (Buffer.from(signatureSegment, "base64url").length !== 64) {
    throw new SigningError(
      "INVALID_COMPACT_JWS",
      "La firma JOSE ES256 debe ocupar exactamente 64 bytes.",
    );
  }

  const trustedKey = trustedKeys.resolve(protectedHeader.kid);
  if (trustedKey === undefined) {
    throw new SigningError("UNTRUSTED_KEY", "El kid no pertenece al catálogo confiable.");
  }
  const algorithm = trustedKey.algorithm;
  if (trustedKey.type !== "public" || algorithm.name !== "ECDSA" ||
      !("namedCurve" in algorithm) || algorithm.namedCurve !== "P-256" ||
      !trustedKey.usages.includes("verify")) {
    throw new SigningError("INVALID_TRUSTED_KEY",
      "La clave confiable debe ser una clave pública ECDSA P-256.");
  }

  try {
    const result = await compactVerify(jwsCompact, trustedKey, {
      algorithms: [ALERT_JWS_ALGORITHM],
    });

    return Object.freeze({
      payloadBytes: new Uint8Array(result.payload),
      alg: ALERT_JWS_ALGORITHM,
      kid: protectedHeader.kid,
    });
  } catch {
    throw new SigningError(
      "SIGNATURE_VERIFICATION_FAILED",
      "La firma JWS no pudo verificarse con la clave confiable.",
    );
  }
}
