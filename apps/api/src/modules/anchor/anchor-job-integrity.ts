import { importJWK, type JWK_EC_Public } from "jose";
import type { Prisma, PrismaClient } from "../../generated/prisma/client.js";
import { inspectPayload } from "../alerts/alert-persistence.js";
import { calculateJwsHash, calculateMessageKey } from "../signing/alert-hashes.js";
import { InMemoryTrustedPublicKeyCatalog } from "../signing/trusted-public-keys.js";
import { verifyAlertJws } from "../signing/verify-alert-jws.js";

const MAX_JWS_LENGTH = 32_768;

export const anchorJobSelect = {
  id: true,
  alertId: true,
  deploymentId: true,
  messageKey: true,
  jwsHash: true,
  state: true,
  txHash: true,
  confirmedLedger: true,
  attemptCount: true,
  automaticFailureCount: true,
  nextAttemptAt: true,
  leaseUntil: true,
  alert: {
    select: {
      id: true,
      sender: true,
      identifier: true,
      sentText: true,
      kind: true,
      severity: true,
      lifecycleState: true,
      anchorStatus: true,
      frozenPayload: true,
      payloadSha256: true,
      jwsCompact: true,
      kid: true,
      messageKey: true,
      jwsHash: true,
      publishedAt: true,
      createdAt: true,
    },
  },
  deployment: {
    select: {
      id: true,
      network: true,
      networkPassphrase: true,
      contractId: true,
      wasmHash: true,
      adminPublicAddress: true,
      generation: true,
      state: true,
      trustedConfigVersion: true,
    },
  },
} satisfies Prisma.AnchorJobSelect;

export type AnchorJobRow = Prisma.AnchorJobGetPayload<{ select: typeof anchorJobSelect }>;

function bytesEqual(left: Uint8Array | null, right: Uint8Array): boolean {
  return left !== null && left.length === right.length &&
    Buffer.from(left).equals(Buffer.from(right));
}

function trustedJwk(value: Prisma.JsonValue, kid: string): JWK_EC_Public & {
  kty: "EC";
  crv: "P-256";
} {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      value["kty"] !== "EC" || value["crv"] !== "P-256" ||
      typeof value["x"] !== "string" || typeof value["y"] !== "string" ||
      "d" in value || (value["kid"] !== undefined && value["kid"] !== kid)) {
    throw new Error("ANCHOR_KEY_INVALID");
  }
  return { kty: "EC", crv: "P-256", x: value["x"], y: value["y"], kid };
}

export async function validateAnchorJobIntegrity(
  prisma: PrismaClient,
  job: AnchorJobRow,
): Promise<boolean> {
  const alert = job.alert;
  if (alert.id !== job.alertId ||
      alert.lifecycleState !== "SIGNED_PENDING_ANCHOR" ||
      alert.kind !== "Alert" ||
      !["PENDING", "SUBMITTED", "RETRYABLE_ERROR"].includes(alert.anchorStatus) ||
      !alert.jwsCompact || alert.jwsCompact.length > MAX_JWS_LENGTH ||
      !alert.kid || !alert.messageKey || !alert.jwsHash ||
      !bytesEqual(job.messageKey, alert.messageKey) || !bytesEqual(job.jwsHash, alert.jwsHash)) {
    return false;
  }
  const frozenPayload = Uint8Array.from(alert.frozenPayload);
  let metadata;
  try {
    metadata = inspectPayload(frozenPayload, Uint8Array.from(alert.payloadSha256));
  } catch {
    return false;
  }
  try {
    if (metadata.kind !== "Alert" || metadata.sender !== alert.sender ||
        metadata.identifier !== alert.identifier || metadata.sentText !== alert.sentText ||
        !bytesEqual(alert.jwsHash, calculateJwsHash(alert.jwsCompact)) ||
        !bytesEqual(alert.messageKey,
          calculateMessageKey({ sender: metadata.sender, identifier: metadata.identifier,
            sent: metadata.sentText }))) {
      return false;
    }
  } catch {
    return false;
  }

  const key = await prisma.publicKey.findUnique({
    where: { kid: alert.kid },
    select: {
      kid: true, publicJwk: true, status: true, validFrom: true, retiredAt: true, revokedAt: true,
    },
  });
  if (!key || key.kid !== alert.kid || key.status === "REVOKED" || key.revokedAt !== null ||
      key.validFrom > alert.createdAt ||
      (key.retiredAt !== null && alert.createdAt > key.retiredAt)) return false;

  try {
    const publicKey = await importJWK(trustedJwk(key.publicJwk, key.kid), "ES256");
    const verified = await verifyAlertJws(alert.jwsCompact,
      new InMemoryTrustedPublicKeyCatalog([[key.kid, publicKey]]));
    return verified.kid === alert.kid &&
      Buffer.from(verified.payloadBytes).equals(Buffer.from(frozenPayload));
  } catch {
    return false;
  }
}
