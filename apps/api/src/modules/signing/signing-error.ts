export type SigningErrorCode =
  | "INVALID_COMPACT_JWS"
  | "INVALID_PROTECTED_HEADER"
  | "UNTRUSTED_KEY"
  | "INVALID_SIGNING_KEY"
  | "INVALID_TRUSTED_KEY"
  | "SIGNING_KEY_SOURCE_UNAVAILABLE"
  | "SIGNATURE_OPERATION_FAILED"
  | "SIGNATURE_VERIFICATION_FAILED"
  | "INVALID_HASH_INPUT";

export class SigningError extends Error {
  override readonly name = "SigningError";

  constructor(readonly code: SigningErrorCode, message: string) {
    super(message);
  }
}
