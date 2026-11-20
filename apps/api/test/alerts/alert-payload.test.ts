import { describe, expect, it } from "vitest";
import { validateAlertInput } from "../../src/modules/alerts/alert-input.js";
import { buildDraftPayload, calculatePayloadDigest, freezeAlertPayload, payloadDigestMatches } from "../../src/modules/alerts/alert-payload.js";
import { identity, input } from "./alert-fixtures.js";

const validated = () => validateAlertInput(input, identity.sent);
describe("bytes y digest M2", () => {
  it("produce el JSON exacto de ADR-007", () => {
    const result = buildDraftPayload(validated(), identity);
    expect(Buffer.from(result.payloadBytes).toString("utf8")).toBe('{"sender":"urn:siga-e:simulacro","identifier":"SIGAE-DEMO-1","sent":"2026-10-21T12:00:00.000Z","status":"Exercise","scope":"Public","msgType":"Alert","info":{"scenario":"SISMO","event":"Sismo ficticio","severity":"Severe","urgency":"Immediate","certainty":"Likely","headline":"SIMULACRO: sismo ficticio","description":"Ejercicio académico ficticio.","expires":"2026-10-21T14:00:00.000Z","areaDesc":"Zona ficticia A"}}');
    expect(result.payloadDigest).toHaveLength(32);
    expect(payloadDigestMatches(result.payloadBytes, result.payloadDigestHex)).toBe(true);
  });
  it("orden de entrada, references vacías y offsets equivalentes no cambian bytes", () => {
    const reordered = { references: [], info: Object.fromEntries(Object.entries({ ...input.info, expires: "2026-10-21T14:00:00.000Z" }).reverse()), kind: "Alert" };
    const a = buildDraftPayload(validated(), identity);
    const b = buildDraftPayload(validateAlertInput(reordered, identity.sent), identity);
    expect(a.payloadBytes).toEqual(b.payloadBytes);
    expect(a.payloadDigestHex).toBe(b.payloadDigestHex);
  });
  it.each([
    ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  ])("SHA-256 reproduce vector %s", (text, hex) => {
    expect(Buffer.from(calculatePayloadDigest(Buffer.from(text))).toString("hex")).toBe(hex);
  });
  it("detecta un byte cambiado y digest malformado sin reserializar", () => {
    const payload = buildDraftPayload(validated(), identity);
    const changed = payload.payloadBytes;
    changed[0] = changed[0]! ^ 1;
    expect(payloadDigestMatches(changed, payload.payloadDigest)).toBe(false);
    for (const bad of ["", payload.payloadDigestHex.toUpperCase(), new Uint8Array(31)]) expect(payloadDigestMatches(payload.payloadBytes, bad)).toBe(false);
    const persisted = Buffer.from(' { "a" : 1 } ');
    expect(payloadDigestMatches(persisted, calculatePayloadDigest(persisted))).toBe(true);
    expect(payloadDigestMatches(Buffer.from('{"a":1}'), calculatePayloadDigest(persisted))).toBe(false);
  });
  it("separa borrador regenerable e instantánea congelada protegida de mutación", () => {
    const draft = buildDraftPayload(validated(), identity);
    const frozen = freezeAlertPayload(validated(), identity, new Date(identity.sent));
    expect(draft.phase).toBe("DRAFT");
    expect(frozen.phase).toBe("FROZEN");
    expect(draft.payloadBytes).toEqual(frozen.payloadBytes);
    frozen.payloadBytes.fill(0);
    frozen.payloadDigest.fill(0);
    expect(payloadDigestMatches(frozen.payloadBytes, frozen.payloadDigest)).toBe(true);
    const edited = buildDraftPayload(validateAlertInput({ ...input, info: { ...input.info, event: "Otro simulacro" } }, identity.sent), identity);
    expect(edited.payloadDigestHex).not.toBe(frozen.payloadDigestHex);
    expect(() => freezeAlertPayload(validated(), identity, new Date(input.info.expires))).toThrow();
  });
  it("preserva Unicode, escapes y formas compuesta/descompuesta distintas", () => {
    const make = (event: string) => buildDraftPayload(validateAlertInput({ ...input, info: { ...input.info, event } }, identity.sent), identity);
    expect(make("é").payloadDigestHex).not.toBe(make("e\u0301").payloadDigestHex);
    const event = '🌊 "área"\n\\';
    expect(JSON.parse(Buffer.from(make(event).payloadBytes).toString("utf8")).info.event).toBe(event);
  });
  it("rechaza identidad con controles y sent no canónico", () => {
    for (const field of ["sender", "identifier", "sent"]) {
      for (const value of ["", "x\n", "x\r", "x\u0000", "x\u2028"]) expect(() => buildDraftPayload(validated(), { ...identity, [field]: value })).toThrow();
    }
    for (const sent of ["2026-10-21T12:00:00Z", "2026-10-21T08:00:00-04:00", "invalid"]) expect(() => buildDraftPayload(validated(), { ...identity, sent })).toThrow();
  });
});
