import type { RequestHandler } from "express";

import { ApplicationError } from "../../../domain/errors/application-error.js";
import { readSessionCookie, validCsrfToken } from "../../../modules/identity/session-authentication.js";

export function createRequireCsrf(secret: Uint8Array, appOrigin: string): RequestHandler {
  if (secret.length < 32 || new URL(appOrigin).protocol !== "https:" || new URL(appOrigin).origin !== appOrigin) {
    throw new TypeError("CSRF_CONFIGURATION_INVALID");
  }
  return (request, _response, next) => {
    const token = readSessionCookie(request.header("cookie"));
    const supplied = request.header("X-CSRF-Token");
    if (request.header("Origin") !== appOrigin || !token || !supplied || !validCsrfToken(token, supplied, secret)) {
      next(new ApplicationError(403, "CSRF_INVALID", "Operación no autorizada", "La solicitud no superó la validación CSRF."));
      return;
    }
    next();
  };
}
