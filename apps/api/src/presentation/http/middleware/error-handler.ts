import { randomUUID } from "node:crypto";

import type { ErrorRequestHandler } from "express";

import { ApplicationError } from "../../../domain/errors/application-error.js";
import type { ProblemDetails } from "../problem-details.js";
import type { AlertDiagnosticReporter } from "../diagnostic-reporting.js";


export interface ReportableError {
  readonly requestId: string;
  readonly errorName: string;
  readonly prismaCode?: string;
  readonly sqlState?: string;
}

export type ErrorReporter = (error: ReportableError) => void;

function isAlertMalformedJsonError(error: unknown, path: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { readonly type?: unknown; readonly status?: unknown };
  const isAlertPath = path === "/api/v1/alerts" || path.startsWith("/api/v1/alerts/");
  return isAlertPath && candidate.type === "entity.parse.failed" && candidate.status === 400;
}

export function createErrorHandler(reportError: ErrorReporter,
  reportDiagnostic?: AlertDiagnosticReporter): ErrorRequestHandler {
  return (error: unknown, request, response, _next) => {
    const requestId =
      typeof response.locals["requestId"] === "string"
        ? response.locals["requestId"]
        : randomUUID();

    const knownError = error instanceof ApplicationError;
    const malformedJson = isAlertMalformedJsonError(error, request.path);
    const status = knownError ? error.status : malformedJson ? 422 : 500;

    if (malformedJson && reportDiagnostic) {
      reportDiagnostic({ requestId, stage: "JSON_PARSE", code: "INVALID_ALERT_PAYLOAD" });
    }

    if (status >= 500) {
      const candidate =
        error !== null && typeof error === "object"
          ? error as {
              name?: unknown;
              code?: unknown;
              meta?: unknown;
            }
          : null;

      const isPrismaError =
        candidate?.name === "PrismaClientKnownRequestError";

      const prismaCode =
        isPrismaError &&
        typeof candidate.code === "string" &&
        /^P\d{4}$/.test(candidate.code)
          ? candidate.code
          : undefined;


      const meta =
        isPrismaError &&
        candidate.meta !== null &&
        typeof candidate.meta === "object"
          ? candidate.meta as {
              code?: unknown;
              driverAdapterError?: {
                cause?: {
                  originalCode?: unknown;
                  code?: unknown;
                };
              };
            }
          : null;

      const posiblesCodigos = [
        meta?.driverAdapterError?.cause?.originalCode,
        meta?.driverAdapterError?.cause?.code,
        meta?.code,
      ];

      const sqlState = posiblesCodigos.find(
        (value): value is string =>
          typeof value === "string" &&
          /^[A-Z0-9]{5}$/.test(value) &&
          !/^P\d{4}$/.test(value)
      );


      reportError({
        requestId,
        errorName: error instanceof Error
          ? error.name
          : "UnknownError",
        ...(prismaCode ? { prismaCode } : {}),
        ...(sqlState ? { sqlState } : {}),
      });
    }

    const problem: ProblemDetails = knownError
      ? {
          type: error.type,
          title: error.title,
          status,
          code: error.code,
          detail: error.publicDetail,
          requestId,
        }
      : malformedJson
      ? {
          type: "about:blank",
          title: "Entrada inválida",
          status,
          code: "INVALID_ALERT_PAYLOAD",
          detail: "La solicitud no es válida.",
          requestId,
        }
      : {
          type: "about:blank",
          title: "Error interno",
          status,
          code: "INTERNAL_ERROR",
          detail: "La solicitud no pudo completarse.",
          requestId,
        };

    response.status(status).type("application/problem+json").json(problem);
  };
}
