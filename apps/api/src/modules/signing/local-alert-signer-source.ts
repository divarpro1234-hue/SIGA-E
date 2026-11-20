import type { AlertSigner } from "./alert-signer.js";

export interface LocalAlertSignerSource {
  /** Returns a signing operation; private key material must remain inside the source. */
  getActiveSigner(): AlertSigner;
}
