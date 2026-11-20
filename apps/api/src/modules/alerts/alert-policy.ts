import { AlertDomainError, severities } from "./alert-input.js";
import type { Severity } from "./alert-input.js";
import { MAX_ALERT_VERSION } from "./alert-persistence.js";

export type AlertState = "DRAFT" | "PENDING_APPROVAL" | "READY_TO_SIGN" | "REJECTED" |
  "SIGNING" | "SIGNED_PENDING_ANCHOR" | "PUBLISHED";
export type ApprovalDecision = "APPROVED" | "REJECTED";
export type M2Action = "EDIT" | "SUBMIT" | "APPROVE" | "REJECT";

export function requiresApproval(severity: Severity): boolean {
  if (!severities.includes(severity)) throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  return severity === "Severe" || severity === "Extreme";
}

export function validateSubmitVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1 || version > MAX_ALERT_VERSION) {
    throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  }
  if (version === MAX_ALERT_VERSION) throw new AlertDomainError("VERSION_LIMIT_REACHED");
}

/** M2 structural policy only: never authorizes actors or validates an approval digest. */
export function nextAlertState(state: AlertState, action: M2Action, severity: Severity): AlertState {
  const critical = requiresApproval(severity);
  if (action === "EDIT" && (state === "DRAFT" || state === "REJECTED")) return "DRAFT";
  if (action === "SUBMIT" && state === "DRAFT") return critical ? "PENDING_APPROVAL" : "READY_TO_SIGN";
  if (state === "PENDING_APPROVAL" && critical) {
    if (action === "APPROVE") return "READY_TO_SIGN";
    if (action === "REJECT") return "REJECTED";
  }
  throw new AlertDomainError("INVALID_STATE_TRANSITION");
}

/** Each successful M2 mutation advances exactly once, including a rejected version's correction. */
export function applyM2Transition(state: AlertState, version: number, action: M2Action, severity: Severity) {
  validateSubmitVersion(version);
  return Object.freeze({ state: nextAlertState(state, action, severity), version: version + 1 });
}
