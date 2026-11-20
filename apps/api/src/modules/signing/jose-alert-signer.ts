import { CompactSign, type CryptoKey } from "jose";

import { ALERT_JWS_ALGORITHM, type AlertSigner } from "./alert-signer.js";
import { SigningError } from "./signing-error.js";

export class JoseAlertSigner implements AlertSigner {
  readonly #privateKey: CryptoKey;

  constructor(
    privateKey: CryptoKey,
    readonly kid: string,
  ) {
    if (typeof kid !== "string" || kid.length === 0) {
      throw new TypeError("kid no puede estar vacío.");
    }
    const algorithm = privateKey.algorithm;
    if (privateKey.type !== "private" || algorithm.name !== "ECDSA" ||
        !("namedCurve" in algorithm) || algorithm.namedCurve !== "P-256" ||
        !privateKey.usages.includes("sign")) {
      throw new SigningError("INVALID_SIGNING_KEY", "La clave de firma debe ser ECDSA privada P-256.");
    }
    this.#privateKey = privateKey;
  }

  async sign(payloadBytes: Uint8Array, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) throw new SigningError("SIGNATURE_OPERATION_FAILED",
      "La operación de firma fue cancelada.");
    const exactPayloadBytes = new Uint8Array(payloadBytes);

    return new CompactSign(exactPayloadBytes)
      .setProtectedHeader({ alg: ALERT_JWS_ALGORITHM, kid: this.kid })
      .sign(this.#privateKey);
  }
}
