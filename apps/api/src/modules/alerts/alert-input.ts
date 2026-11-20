import { z } from "zod";

export class AlertDomainError extends Error {
  override readonly name = "AlertDomainError";
  constructor(readonly code: "INVALID_ALERT_PAYLOAD" | "INVALID_STATE_TRANSITION" | "VERSION_LIMIT_REACHED") {
    super(code === "INVALID_ALERT_PAYLOAD" ? "Contenido de alerta inválido." :
      code === "VERSION_LIMIT_REACHED" ? "La versión de la alerta no puede incrementarse." :
      "Transición de alerta no permitida.");
  }
}

export const severities = ["Extreme", "Severe", "Moderate", "Minor", "Unknown"] as const;
export type Severity = typeof severities[number];

const submitInputSchema = z.strictObject({
  expectedVersion: z.number().int().safe().positive(),
});
export type SubmitInput = z.infer<typeof submitInputSchema>;

const issueInputSchema = z.strictObject({
  expectedDigestHex: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type IssueInput = z.infer<typeof issueInputSchema>;

const approveInputSchema = z.strictObject({
  expectedDigestHex: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedVersion: z.number().int().safe().positive(),
});
export type ApproveInput = z.infer<typeof approveInputSchema>;

const rejectInputSchema = z.strictObject({
  reason: z.string().refine((value) => Array.from(value).length >= 3 && Array.from(value).length <= 500 &&
    !value.includes("\u0000")),
  expectedDigestHex: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedVersion: z.number().int().safe().positive(),
});
export type RejectInput = z.infer<typeof rejectInputSchema>;

export function validateSubmitInput(value: unknown): SubmitInput {
  const result = submitInputSchema.safeParse(value);
  if (!result.success) throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  return result.data;
}

export function validateIssueInput(value: unknown): IssueInput {
  const result = issueInputSchema.safeParse(value);
  if (!result.success) throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  return result.data;
}

export function validateApproveInput(value: unknown): ApproveInput {
  const result = approveInputSchema.safeParse(value);
  if (!result.success) throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  return result.data;
}

export function validateRejectInput(value: unknown): RejectInput {
  const result = rejectInputSchema.safeParse(value);
  if (!result.success) throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  return result.data;
}

// OpenAPI lengths count Unicode code points. Text is neither trimmed nor NFC-normalized.
const text = (min: number, max: number) => z.string().refine((value) => {
  const length = Array.from(value).length;
  return length >= min && length <= max;
});
const isoDateTime = z.iso.datetime({ offset: true });
const dateTime = z.string().refine((value) =>
  /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.test(value) &&
  isoDateTime.safeParse(value.toUpperCase()).success && Number.isFinite(Date.parse(value)));
const inputSchema = z.strictObject({
  kind: z.literal("Alert"),
  info: z.strictObject({
    scenario: z.enum(["INUNDACION", "DESLIZAMIENTO", "SISMO"]),
    event: text(1, 120),
    severity: z.enum(severities),
    urgency: z.enum(["Immediate", "Expected", "Future", "Past", "Unknown"]),
    certainty: z.enum(["Observed", "Likely", "Possible", "Unlikely", "Unknown"]),
    headline: text(10, 200).refine((value) => value.includes("SIMULACRO")),
    description: text(10, 4000),
    expires: dateTime,
    areaDesc: text(3, 200),
  }),
  references: z.array(z.never()).max(0).optional(),
});

export type AlertInput = z.infer<typeof inputSchema>;
declare const validatedInput: unique symbol;
export type ValidatedAlertInput = Readonly<Omit<AlertInput, "info">> & {
  readonly info: Readonly<AlertInput["info"]>;
  readonly [validatedInput]: true;
};

export interface MessageIdentity {
  readonly sender: string;
  readonly identifier: string;
  readonly sent: string;
}

export function validateMessageIdentity(identity: MessageIdentity): void {
  if ([identity.sender, identity.identifier, identity.sent].some((value) =>
    typeof value !== "string" || !value.length || /[\p{Cc}\u2028\u2029]/u.test(value)) ||
    !dateTime.safeParse(identity.sent).success ||
    new Date(identity.sent).toISOString() !== identity.sent) {
    throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  }
}

/** sent is server-owned; submitAt is required by the freezing operation, never read from a clock here. */
export function validateAlertInput(value: unknown, sent: string, submitAt?: Date): ValidatedAlertInput {
  const result = inputSchema.safeParse(value);
  if (!result.success || !dateTime.safeParse(sent).success) {
    throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  }
  const expires = new Date(result.data.info.expires).toISOString();
  if (Date.parse(expires) <= Date.parse(sent) ||
    (submitAt !== undefined && (!Number.isFinite(submitAt.getTime()) || Date.parse(expires) <= submitAt.getTime()))) {
    throw new AlertDomainError("INVALID_ALERT_PAYLOAD");
  }
  const info = Object.freeze({ ...result.data.info, expires });
  // Empty references have no representation in an Alert payload.
  return Object.freeze({ kind: "Alert", info }) as ValidatedAlertInput;
}
