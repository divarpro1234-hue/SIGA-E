import { createHash, timingSafeEqual } from "node:crypto";

import { validateAlertInput, validateMessageIdentity } from "./alert-input.js";
import type { MessageIdentity, ValidatedAlertInput } from "./alert-input.js";

export function calculatePayloadDigest(payloadBytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(payloadBytes).digest());
}

export function payloadDigestMatches(payloadBytes: Uint8Array, expected: Uint8Array | string): boolean {
  if (typeof expected === "string" && !/^[a-f0-9]{64}$/u.test(expected)) return false;
  const digest = typeof expected === "string" ? Buffer.from(expected, "hex") : expected;
  return digest.length === 32 && timingSafeEqual(calculatePayloadDigest(payloadBytes), digest);
}

/** Fixed insertion order per ADR-007; not the audit serializer or interoperable JCS. */
function serialize(input: ValidatedAlertInput, identity: MessageIdentity): Uint8Array {
  validateMessageIdentity(identity);
  const { info } = input;
  return Buffer.from(JSON.stringify({
    sender: identity.sender,
    identifier: identity.identifier,
    sent: identity.sent,
    status: "Exercise",
    scope: "Public",
    msgType: "Alert",
    info: {
      scenario: info.scenario,
      event: info.event,
      severity: info.severity,
      urgency: info.urgency,
      certainty: info.certainty,
      headline: info.headline,
      description: info.description,
      expires: info.expires,
      areaDesc: info.areaDesc,
    },
  }), "utf8");
}

export interface PayloadSnapshot<Phase extends "DRAFT" | "FROZEN"> {
  readonly phase: Phase;
  readonly payloadBytes: Uint8Array;
  readonly payloadDigest: Uint8Array;
  readonly payloadDigestHex: string;
}

function snapshot<Phase extends "DRAFT" | "FROZEN">(phase: Phase, source: Uint8Array): PayloadSnapshot<Phase> {
  const bytes = Uint8Array.from(source);
  const digest = calculatePayloadDigest(bytes);
  // Typed arrays are mutable: defensive copies keep the captured bytes immutable.
  return Object.freeze({
    phase,
    get payloadBytes() { return Uint8Array.from(bytes); },
    get payloadDigest() { return Uint8Array.from(digest); },
    payloadDigestHex: Buffer.from(digest).toString("hex"),
  });
}

export function buildDraftPayload(input: ValidatedAlertInput, identity: MessageIdentity): PayloadSnapshot<"DRAFT"> {
  return snapshot("DRAFT", serialize(validateAlertInput(input, identity.sent), identity));
}

/** Called once by a future transactional submit. Review/signing must use persisted bytes afterwards. */
export function freezeAlertPayload(input: ValidatedAlertInput, identity: MessageIdentity, submitAt: Date): PayloadSnapshot<"FROZEN"> {
  return snapshot("FROZEN", serialize(validateAlertInput(input, identity.sent, submitAt), identity));
}
