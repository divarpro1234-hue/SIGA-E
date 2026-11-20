export const ALERT_JWS_ALGORITHM = "ES256" as const;
export const ALERT_SIGNING_TIMEOUT_MS = 3000;

export interface AlertSigner {
  readonly kid: string;

  sign(payloadBytes: Uint8Array, signal?: AbortSignal): Promise<string>;
}
