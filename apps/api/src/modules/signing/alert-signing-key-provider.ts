import type { CryptoKey } from "jose";
import type { AlertSigner } from "./alert-signer.js";

export interface AlertSigningKeyProvider {
  /** Returns an in-process signer; retrieving the signer must not perform network I/O. */
  getActiveSigner(): AlertSigner;
  getTrustedPublicKey(kid: string): CryptoKey;
}
