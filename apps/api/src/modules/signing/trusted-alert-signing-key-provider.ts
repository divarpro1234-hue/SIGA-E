import type { CryptoKey } from "jose";
import type { AlertSigningKeyProvider } from "./alert-signing-key-provider.js";
import type { AlertSigner } from "./alert-signer.js";
import type { LocalAlertSignerSource } from "./local-alert-signer-source.js";
import type { TrustedPublicKeyCatalog } from "./trusted-public-keys.js";
import { SigningError } from "./signing-error.js";

export class TrustedAlertSigningKeyProvider implements AlertSigningKeyProvider {
  readonly #source: LocalAlertSignerSource;
  readonly #trustedPublicKeys: TrustedPublicKeyCatalog;

  constructor(
    source: LocalAlertSignerSource,
    trustedPublicKeys: TrustedPublicKeyCatalog,
  ) {
    this.#source = source;
    this.#trustedPublicKeys = trustedPublicKeys;
  }

  getActiveSigner(): AlertSigner {
    let signer: AlertSigner;
    try {
      signer = this.#source.getActiveSigner();
    } catch {
      throw new SigningError("SIGNING_KEY_SOURCE_UNAVAILABLE",
        "La fuente de claves de firma no está disponible.");
    }

    if (!signer || typeof signer.kid !== "string" || signer.kid.length === 0 ||
        typeof signer.sign !== "function") {
      throw new SigningError("INVALID_SIGNING_KEY",
        "La fuente no proporcionó un firmante válido.");
    }

    this.getTrustedPublicKey(signer.kid);
    return new SanitizedTrustedSigner(signer);
  }

  getTrustedPublicKey(kid: string): CryptoKey {
    let trustedKey;
    try {
      trustedKey = this.#trustedPublicKeys.resolve(kid);
    } catch {
      throw new SigningError("UNTRUSTED_KEY",
        "El identificador de clave no pudo validarse.");
    }
    if (!trustedKey) {
      throw new SigningError("UNTRUSTED_KEY",
        "El identificador de clave no está en el catálogo confiable.");
    }
    if (trustedKey.type !== "public" || trustedKey.algorithm.name !== "ECDSA" ||
        !("namedCurve" in trustedKey.algorithm) || trustedKey.algorithm.namedCurve !== "P-256" ||
        !trustedKey.usages.includes("verify")) {
      throw new SigningError("INVALID_TRUSTED_KEY",
        "La clave pública confiable no cumple la política ES256.");
    }

    return trustedKey;
  }
}

class SanitizedTrustedSigner implements AlertSigner {
  readonly kid: string;
  readonly #signer: AlertSigner;

  constructor(signer: AlertSigner) {
    this.#signer = signer;
    this.kid = signer.kid;
  }

  async sign(payloadBytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    try {
      return await this.#signer.sign(payloadBytes, signal);
    } catch {
      throw new SigningError("SIGNATURE_OPERATION_FAILED",
        "La operación de firma no pudo completarse.");
    }
  }
}
