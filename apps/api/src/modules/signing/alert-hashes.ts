import { createHash } from "node:crypto";

import { SigningError } from "./signing-error.js";

const compactJwsPattern = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const lineBreakPattern = /[\r\n]/u;
const messageKeyDomain = "SIGA-E-ALERT-ID-v1";

export interface AlertIdentity {
  readonly sender: string;
  readonly identifier: string;
  readonly sent: string;
}

export function calculateJwsHash(jwsCompact: string): Uint8Array {
  if (!compactJwsPattern.test(jwsCompact)) {
    throw new SigningError(
      "INVALID_HASH_INPUT",
      "jwsCompact debe ser ASCII y contener tres segmentos base64url exactos.",
    );
  }

  return new Uint8Array(createHash("sha256").update(jwsCompact, "ascii").digest());
}

export function calculateMessageKey(identity: AlertIdentity): Uint8Array {
  const fields = [identity.sender, identity.identifier, identity.sent];
  if (fields.some((field) => field.length === 0 || lineBreakPattern.test(field))) {
    throw new SigningError(
      "INVALID_HASH_INPUT",
      "sender, identifier y sent deben ser textos no vacíos sin CR ni LF.",
    );
  }

  const canonicalInput = `${messageKeyDomain}\n${identity.sender}\n${identity.identifier}\n${identity.sent}`;
  return new Uint8Array(createHash("sha256").update(canonicalInput, "utf8").digest());
}

export function bytesToLowerHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}
