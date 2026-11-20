import express, { type Express } from "express";
import { join } from "node:path";

import type { SessionReader } from "./modules/identity/session-reader.js";
import type { PendingUserService } from "./modules/identity/create-pending-user.js";
import type { LoginService } from "./modules/identity/login-service.js";
import type { TotpReconfigurationService } from "./modules/identity/totp-reconfiguration.js";
import type { DraftAlertService } from "./modules/alerts/alert-draft-service.js";
import type { PublicAlertApplicationService } from "./modules/public/public-alert-service.js";

import {
  createErrorHandler,
  type ErrorReporter,
} from "./presentation/http/middleware/error-handler.js";
import type { AlertDiagnosticReporter } from "./presentation/http/diagnostic-reporting.js";
import { notFound } from "./presentation/http/middleware/not-found.js";
import { requestContext } from "./presentation/http/middleware/request-context.js";
import { apiV1Router } from "./presentation/http/routes/index.js";
import { createIdentityRouter } from "./presentation/http/routes/identity-routes.js";
import { createAlertRouter } from "./presentation/http/routes/alert-routes.js";
import { createPublicAlertRouter } from "./presentation/http/routes/public-alert-routes.js";

export interface CreateAppOptions {
  readonly production?: boolean;
  readonly webDistDirectory?: string;
  readonly reportError?: ErrorReporter;
  readonly sessionReader?: SessionReader;
  readonly csrfSecret?: Uint8Array;
  readonly pendingUserService?: PendingUserService;
  readonly appOrigin?: string;
  readonly loginService?: LoginService;
  readonly totpReconfigurationService?: TotpReconfigurationService;
  readonly alertDraftService?: DraftAlertService;
  readonly publicAlertService?: PublicAlertApplicationService;
  readonly alertDiagnosticReporter?: AlertDiagnosticReporter;
}

const ignoreError: ErrorReporter = () => undefined;

export function createApp(options: CreateAppOptions = {}): Express {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", options.production ? 1 : false);
  if (options.production) {
    app.use((request, response, next) => {
      response.set({
        "Content-Security-Policy": "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        "X-Content-Type-Options": "nosniff",
        "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
      });
      if (!request.secure && request.path !== "/api/v1/health" && options.appOrigin) {
        response.redirect(308, `${options.appOrigin}${request.originalUrl}`);
        return;
      }
      if (request.secure) response.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      next();
    });
  }
  app.use(requestContext);
  app.use(express.json({ limit: "256kb", strict: true }));
  if (options.publicAlertService)
    app.use("/api/v1/public", createPublicAlertRouter(options.publicAlertService));
  if (options.sessionReader && options.csrfSecret && options.csrfSecret.length >= 32)
    app.use("/api/v1", createIdentityRouter(options.sessionReader, options.csrfSecret,
      options.pendingUserService, options.appOrigin, options.loginService, options.totpReconfigurationService));
  if (options.sessionReader && options.csrfSecret && options.csrfSecret.length >= 32 &&
      options.appOrigin && options.alertDraftService)
    app.use("/api/v1", createAlertRouter(options.sessionReader, options.csrfSecret,
      options.appOrigin, options.alertDraftService));
  app.use("/api/v1", apiV1Router);
  if (options.webDistDirectory) {
    app.use(express.static(options.webDistDirectory, { dotfiles: "deny", index: false }));
    app.get(/.*/, (request, response, next) => {
      if (request.path === "/api" || request.path.startsWith("/api/") || !request.accepts("html")) {
        next();
        return;
      }
      response.sendFile(join(options.webDistDirectory!, "index.html"), (error) => {
        if (error) next(error);
      });
    });
  }
  app.use(notFound);
  app.use(createErrorHandler(options.reportError ?? ignoreError, options.alertDiagnosticReporter));

  return app;
}
