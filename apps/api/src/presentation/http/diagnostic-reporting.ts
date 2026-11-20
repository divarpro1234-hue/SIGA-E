export const alertDiagnosticStages = [
  "JSON_PARSE",
  "IDENTITY_VALIDATION",
  "INPUT_VALIDATION",
  "PAYLOAD_BUILD",
  "PERSISTENCE_INPUT",
  "DATABASE_CREATE",
  "AUDIT_APPEND",
] as const;

export type AlertDiagnosticStage = typeof alertDiagnosticStages[number];

export type AlertDiagnosticCode =
  | "INVALID_ALERT_PAYLOAD"
  | "INVALID_PERSISTENCE_INPUT";

export interface AlertDiagnosticEvent {
  readonly requestId: string;
  readonly stage: AlertDiagnosticStage;
  readonly code: AlertDiagnosticCode;
}

export type AlertDiagnosticReporter = (event: AlertDiagnosticEvent) => void;
