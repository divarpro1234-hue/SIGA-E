import { describe, expect, it } from "vitest";
import { severities } from "../../src/modules/alerts/alert-input.js";
import { applyM2Transition, nextAlertState, requiresApproval, validateSubmitVersion } from "../../src/modules/alerts/alert-policy.js";
import { AlertDomainError } from "../../src/modules/alerts/alert-input.js";
import { MAX_ALERT_VERSION } from "../../src/modules/alerts/alert-persistence.js";
import type { AlertState, M2Action } from "../../src/modules/alerts/alert-policy.js";

describe("política M2", () => {
  it.each(severities)("aplica revisión y submit a %s", (severity) => {
    const critical = severity === "Severe" || severity === "Extreme";
    expect(requiresApproval(severity)).toBe(critical);
    expect(nextAlertState("DRAFT", "SUBMIT", severity)).toBe(critical ? "PENDING_APPROVAL" : "READY_TO_SIGN");
  });
  it("recorre rechazo, corrección versionada, nueva revisión y aprobación", () => {
    let current: { state: AlertState; version: number } = { state: "DRAFT", version: 1 };
    for (const [action, expected] of [["EDIT", "DRAFT"], ["SUBMIT", "PENDING_APPROVAL"], ["REJECT", "REJECTED"], ["EDIT", "DRAFT"], ["SUBMIT", "PENDING_APPROVAL"], ["APPROVE", "READY_TO_SIGN"]] as const) {
      const next = applyM2Transition(current.state, current.version, action, "Severe");
      expect(next).toEqual({ state: expected, version: current.version + 1 });
      current = next;
    }
    expect(current.state).not.toBe("APPROVED");
  });
  it("rechaza todas las parejas estado/acción no autorizadas de M2", () => {
    const states: AlertState[] = ["DRAFT", "PENDING_APPROVAL", "REJECTED", "READY_TO_SIGN", "SIGNING", "SIGNED_PENDING_ANCHOR", "PUBLISHED"];
    const actions: M2Action[] = ["EDIT", "SUBMIT", "APPROVE", "REJECT"];
    const allowed = new Set(["DRAFT:EDIT", "DRAFT:SUBMIT", "REJECTED:EDIT", "PENDING_APPROVAL:APPROVE", "PENDING_APPROVAL:REJECT"]);
    for (const state of states) for (const action of actions) {
      if (!allowed.has(`${state}:${action}`)) expect(() => nextAlertState(state, action, "Severe")).toThrow();
    }
    expect(() => nextAlertState("PENDING_APPROVAL", "APPROVE", "Minor")).toThrow();
    expect(() => nextAlertState("APPROVED" as AlertState, "EDIT", "Severe")).toThrow();
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])("rechaza versión inválida %s", (version) => {
    expect(() => applyM2Transition("DRAFT", version, "EDIT", "Severe")).toThrow();
  });
  it("distingue versión fuera de límites de versión máxima no incrementable", () => {
    expect(() => validateSubmitVersion(MAX_ALERT_VERSION + 1)).toThrow(AlertDomainError);
    expect(() => validateSubmitVersion(MAX_ALERT_VERSION)).toThrow("La versión de la alerta no puede incrementarse.");
    expect(() => applyM2Transition("DRAFT", MAX_ALERT_VERSION, "SUBMIT", "Severe"))
      .toThrow("La versión de la alerta no puede incrementarse.");
  });
});
