import { describe, expect, it } from "vitest";
import { AlertDomainError, severities, validateAlertInput, validateSubmitInput } from "../../src/modules/alerts/alert-input.js";
import { identity, input } from "./alert-fixtures.js";

const parse = (value: unknown) => validateAlertInput(value, identity.sent);
describe("AlertInput estricto", () => {
  it("valida exclusivamente el cuerpo estricto de submit", () => {
    expect(validateSubmitInput({ expectedVersion: 2 })).toEqual({ expectedVersion: 2 });
    for (const value of [
      undefined, null, [], "2", 2, {}, { expectedVersion: 0 }, { expectedVersion: -1 },
      { expectedVersion: 1.5 }, { expectedVersion: NaN }, { expectedVersion: Infinity },
      { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
      { expectedVersion: 2, submitAt: new Date().toISOString() },
      { expectedVersion: 2, payloadDigestHex: "0".repeat(64) },
    ]) {
      expect(() => validateSubmitInput(value)).toThrow(AlertDomainError);
    }
  });
  it("valida y normaliza sin modificar la entrada", () => {
    expect(parse(input).info.expires).toBe("2026-10-21T14:00:00.000Z");
    expect(input.info.expires).toBe("2026-10-21T10:00:00-04:00");
    expect(parse({ ...input, references: [] })).toEqual(parse(input));
  });
  it.each(["INUNDACION", "DESLIZAMIENTO", "SISMO"])("acepta escenario %s", (scenario) => {
    for (const severity of severities) expect(parse({ ...input, info: { ...input.info, scenario, severity } })).toBeDefined();
  });
  it("acepta todas las urgencias y certezas documentadas", () => {
    for (const urgency of ["Immediate", "Expected", "Future", "Past", "Unknown"]) {
      for (const certainty of ["Observed", "Likely", "Possible", "Unlikely", "Unknown"]) {
        expect(parse({ ...input, info: { ...input.info, urgency, certainty } })).toBeDefined();
      }
    }
  });
  it("normaliza RFC 3339 con t/z minúsculas y valida años bisiestos", () => {
    expect(parse({ ...input, info: { ...input.info, expires: "2026-10-21t14:00:00z" } }).info.expires).toBe("2026-10-21T14:00:00.000Z");
    expect(parse({ ...input, info: { ...input.info, expires: "2028-02-29T14:00:00Z" } })).toBeDefined();
    expect(() => parse({ ...input, info: { ...input.info, expires: "2027-02-29T14:00:00Z" } })).toThrow();
  });
  it.each(["authorId", "sender", "identifier", "sent", "status", "scope", "state", "lifecycleState", "version", "digest", "payloadDigestHex", "jwsCompact", "kid", "contractId", "unknown"])("rechaza atributo %s", (field) => {
    expect(() => parse({ ...input, [field]: "privado" })).toThrow(AlertDomainError);
    expect(() => parse({ ...input, info: { ...input.info, [field]: "privado" } })).toThrow(AlertDomainError);
  });
  it.each([null, [], {}, { ...input, kind: "Update" }, { ...input, kind: "Cancel" }, { ...input, references: [{}] }])("rechaza estructura inválida %#", (value) => {
    expect(() => parse(value)).toThrow("Contenido de alerta inválido.");
  });
  it.each([
    ["scenario", "REAL"], ["severity", "severe"], ["urgency", "Now"], ["certainty", "Yes"],
    ["headline", "simulacro de prueba"], ["headline", "SIMULACRO"], ["event", ""],
    ["description", "corta"], ["areaDesc", "AA"], ["event", 1],
    ["expires", "2026-10-21"], ["expires", "2026-10-21T14:00:00"],
    ["expires", "2026-10-21T14:00Z"],
    ["expires", "2026-02-30T14:00:00Z"], ["expires", "2026-10-21T25:00:00Z"],
    ["expires", identity.sent], ["expires", "2026-10-20T14:00:00Z"],
  ])("rechaza %s inválido %#", (field, value) => {
    expect(() => parse({ ...input, info: { ...input.info, [field]: value } })).toThrow(AlertDomainError);
  });
  it("exige todos los campos", () => {
    for (const field of Object.keys(input.info)) {
      const info = { ...input.info } as Record<string, unknown>;
      delete info[field];
      expect(() => parse({ ...input, info })).toThrow(AlertDomainError);
    }
  });
  it("valida límites por caracteres Unicode sin recortar textos", () => {
    for (const [field, min, max] of [["event", 1, 120], ["description", 10, 4000], ["areaDesc", 3, 200]] as const) {
      for (const length of [min, max]) expect(parse({ ...input, info: { ...input.info, [field]: "🌊".repeat(length) } })).toBeDefined();
      for (const length of [min - 1, max + 1]) expect(() => parse({ ...input, info: { ...input.info, [field]: "🌊".repeat(length) } })).toThrow();
    }
    expect(parse({ ...input, info: { ...input.info, headline: "SIMULACRO " + "🌊".repeat(190) } })).toBeDefined();
    expect(() => parse({ ...input, info: { ...input.info, headline: "SIMULACRO " + "🌊".repeat(191) } })).toThrow();
    expect(parse({ ...input, info: { ...input.info, event: " X " } }).info.event).toBe(" X ");
  });
  it("permite borrador expirado pero exige vigencia al enviar", () => {
    expect(parse(input)).toBeDefined();
    for (const now of [
      new Date("2026-10-21T14:00:00Z"),
      new Date("2026-10-21T14:00:01Z"),
      new Date(NaN),
    ]) {
      expect(() => validateAlertInput(input, identity.sent, now)).toThrow(AlertDomainError);
    }
    expect(() => validateAlertInput(input, "inválida")).toThrow(AlertDomainError);
  });
  it("valida expires estrictamente después de submitAt", () => {
    const expires = new Date("2026-10-21T14:00:00Z");
    expect(validateAlertInput(input, identity.sent, new Date("2026-10-21T13:59:59.999Z"))).toBeDefined();
    expect(() => validateAlertInput(input, identity.sent, expires)).toThrow(AlertDomainError);
    expect(() => validateAlertInput(input, identity.sent, new Date("2026-10-21T14:00:00.001Z"))).toThrow(AlertDomainError);
  });
});
