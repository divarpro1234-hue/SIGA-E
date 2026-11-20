import type { AlertaFirmada } from "./types.js";

const timestampPattern = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u;
const lineBreakPattern = /[\r\n]/u;
const forbiddenIntervals: readonly (readonly [number, number])[] = [
  [0x0000, 0x0008], [0x000b, 0x001f], [0x007f, 0x009f],
  [0x00ad, 0x00ad], [0x034f, 0x034f], [0x061c, 0x061c],
  [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180f],
  [0x200b, 0x200b], [0x200e, 0x200f], [0x2028, 0x202e],
  [0x2060, 0x2069], [0x3164, 0x3164], [0xd800, 0xdfff],
  [0xfe00, 0xfe0d], [0xfeff, 0xfeff], [0xffa0, 0xffa0],
  [0xe0000, 0xe007f], [0xe0100, 0xe01ef],
];
// U+200C/U+200D y U+FE0E/U+FE0F quedan permitidos por la especificación.

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasForbiddenCharacter(value: string): boolean {
  for (const char of value) {
    const point = char.codePointAt(0);
    if (point === undefined || forbiddenIntervals.some(([start, end]) => point >= start && point <= end)) {
      return true;
    }
  }
  return false;
}

function allTextAllowed(root: unknown): boolean {
  const pending: unknown[] = [root];
  let visited = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    visited += 1;
    if (visited > 8192) return false;
    if (typeof current === "string") {
      if (hasForbiddenCharacter(current)) return false;
    } else if (Array.isArray(current)) {
      pending.push(...current);
    } else if (isRecord(current)) {
      for (const [key, value] of Object.entries(current)) {
        if (hasForbiddenCharacter(key)) return false;
        pending.push(value);
      }
    }
  }
  return true;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** RFC 3339 estricto; conserva el texto original para messageKey. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = timestampPattern.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (year < 1 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const days = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > (days[month - 1] ?? 0)) return null;
  const zone = match[7];
  if (zone === undefined) return null;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !lineBreakPattern.test(value);
}

function validLength(value: unknown, minimum: number, maximum: number): value is string {
  if (typeof value !== "string" || value.length > maximum * 16) return false;
  // El carril UI define longitudes en grafemas. Sin Segmenter se falla cerrado.
  if (typeof Intl.Segmenter !== "function") return false;
  let count = 0;
  for (const _segment of new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value)) {
    count += 1;
    if (count > maximum) return false;
  }
  return count >= minimum;
}

const scenarios = new Set(["INUNDACION", "DESLIZAMIENTO", "SISMO"]);
const severities = new Set(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]);
const urgencies = new Set(["Immediate", "Expected", "Future", "Past", "Unknown"]);
const certainties = new Set(["Observed", "Likely", "Possible", "Unlikely", "Unknown"]);
const messageTypes = new Set(["Alert", "Update", "Cancel"]);

export interface PoliticaValida {
  readonly alerta: AlertaFirmada;
  readonly sentMs: number;
  readonly expiresMs: number;
}

export function validarPoliticaPayload(payload: unknown): PoliticaValida | null {
  if (!isRecord(payload) || !allTextAllowed(payload)) return null;
  if (!validIdentity(payload.sender) || !validIdentity(payload.identifier) || !validIdentity(payload.sent)) return null;
  const sentMs = parseTimestamp(payload.sent);
  if (sentMs === null || payload.status !== "Exercise" || payload.scope !== "Public") return null;
  if (typeof payload.msgType !== "string" || !messageTypes.has(payload.msgType)) return null;
  if (!isRecord(payload.info)) return null;
  const info = payload.info;
  if (typeof info.scenario !== "string" || !scenarios.has(info.scenario)) return null;
  if (typeof info.severity !== "string" || !severities.has(info.severity)) return null;
  if (typeof info.urgency !== "string" || !urgencies.has(info.urgency)) return null;
  if (typeof info.certainty !== "string" || !certainties.has(info.certainty)) return null;
  if (!validLength(info.event, 1, 120) || !validLength(info.headline, 10, 200)) return null;
  if (!validLength(info.description, 10, 4000) || !validLength(info.areaDesc, 3, 200)) return null;
  if (!info.headline.includes("SIMULACRO")) return null;
  const expiresMs = parseTimestamp(info.expires);
  if (expiresMs === null || expiresMs <= sentMs) return null;
  if (payload.references !== undefined) {
    if (!Array.isArray(payload.references) || payload.references.some((reference: unknown) =>
      !isRecord(reference) || !validIdentity(reference.sender) ||
      !validIdentity(reference.identifier) || !validIdentity(reference.sent) ||
      parseTimestamp(reference.sent) === null)) return null;
  }
  if (payload.msgType !== "Alert" && (!Array.isArray(payload.references) || payload.references.length === 0)) return null;
  return { alerta: payload as unknown as AlertaFirmada, sentMs, expiresMs };
}
