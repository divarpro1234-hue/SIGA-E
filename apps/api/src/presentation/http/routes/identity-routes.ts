import { Router, type Router as ExpressRouter } from "express";

import type { SessionReader } from "../../../modules/identity/session-reader.js";
import type { InternalUser } from "../../../modules/identity/session-reader.js";
import { createRequireSession } from "../middleware/identity-authorization.js";
import { csrfTokenForSession, readSessionCookie } from "../../../modules/identity/session-authentication.js";
import type { PendingUserService } from "../../../modules/identity/create-pending-user.js";
import { createRequireRoles } from "../middleware/identity-authorization.js";
import { createRequireCsrf } from "../middleware/csrf.js";
import { z } from "zod";
import { ApplicationError } from "../../../domain/errors/application-error.js";
import type { LoginService } from "../../../modules/identity/login-service.js";
import { authRequired } from "../../../modules/identity/session-authentication.js";
import type { TotpReconfigurationService } from "../../../modules/identity/totp-reconfiguration.js";

const pendingUserSchema = z.strictObject({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  role: z.enum(["AUTHOR", "APPROVER", "ADMIN"]),
});

export function createIdentityRouter(
  reader: SessionReader, csrfSecret: Uint8Array,
  pendingUsers?: PendingUserService, appOrigin?: string, loginService?: LoginService,
  totpReconfigurationService?: TotpReconfigurationService,
): ExpressRouter {
  const router = Router();
  if (loginService && appOrigin) {
    const credentials = z.strictObject({ email: z.email().max(254), password: z.string().max(512) });
    const factor = z.strictObject({ challengeId: z.string(), code: z.string().regex(/^\d{6}$/) });
    router.post("/auth/login", async (request, response, next) => {
      try {
        const input = credentials.safeParse(request.body);
        if (!input.success) throw new ApplicationError(422, "VALIDATION_ERROR", "Entrada inválida", "Los datos de la solicitud no son válidos.");
        const result = await loginService.login(input.data.email, input.data.password, request.ip || "unknown");
        response.set("Cache-Control", "no-store");
        if (!result.ok) throw authFailure(result.reason, response);
        response.status(200).json({ challengeId: result.challengeId, expiresAt: result.expiresAt });
      } catch (error) { next(error); }
    });
    router.post("/auth/totp/verify", async (request, response, next) => {
      try {
        const input = factor.safeParse(request.body);
        if (!input.success) throw new ApplicationError(422, "VALIDATION_ERROR", "Entrada inválida", "Los datos de la solicitud no son válidos.");
        const result = await loginService.verify(input.data.challengeId, input.data.code, request.ip || "unknown");
        response.set("Cache-Control", "no-store");
        if (!result.ok) throw authFailure(result.reason, response);
        response.cookie("sigae_session", result.token, { httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 8 * 60 * 60_000 });
        response.status(200).json({ user: result.user, csrfToken: csrfTokenForSession(result.token, csrfSecret) });
      } catch (error) { next(error); }
    });
    router.post("/auth/logout", createRequireSession(reader), createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const token = readSessionCookie(request.header("cookie"));
        if (!token) throw authRequired();
        const user = response.locals["authUser"] as InternalUser;
        await loginService.logout(token, user.id);
        response.clearCookie("sigae_session", { httpOnly: true, secure: true, sameSite: "strict", path: "/" });
        response.set("Cache-Control", "no-store").status(204).end();
      } catch (error) { next(error); }
    });
  }
  if (appOrigin && totpReconfigurationService) {
    const reconfigureStart = z.strictObject({
      password: z.string().max(512), currentCode: z.string().regex(/^\d{6}$/),
    });
    const reconfigureConfirm = z.strictObject({
      reconfigureToken: z.string(), newCode: z.string().regex(/^\d{6}$/),
    });
    router.post("/auth/totp/reconfigure/start", createRequireSession(reader),
      createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
        try {
          const input = reconfigureStart.safeParse(request.body);
          if (!input.success) throw new ApplicationError(422, "VALIDATION_ERROR", "Entrada inválida",
            "Los datos de la solicitud no son válidos.");
          const user = response.locals["authUser"] as InternalUser;
          const result = await totpReconfigurationService.start(user.id, input.data.password, input.data.currentCode,
            request.ip || "unknown");
          response.set("Cache-Control", "no-store").set("Referrer-Policy", "no-referrer").status(200).json(result);
        } catch (error) { next(error); }
      });
    router.post("/auth/totp/reconfigure/confirm", createRequireSession(reader),
      createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
        try {
          const input = reconfigureConfirm.safeParse(request.body);
          if (!input.success) throw new ApplicationError(422, "VALIDATION_ERROR", "Entrada inválida",
            "Los datos de la solicitud no son válidos.");
          const user = response.locals["authUser"] as InternalUser;
          await totpReconfigurationService.confirm(user.id, input.data.reconfigureToken, input.data.newCode);
          response.status(204).end();
        } catch (error) { next(error); }
      });
  }
  router.get("/auth/me", createRequireSession(reader), (_request, response) => {
    const token = readSessionCookie(_request.header("cookie"));
    if (!token) { response.sendStatus(401); return; }
    const user = response.locals["authUser"] as InternalUser;
    response.set("Cache-Control", "no-store");
    response.set("Vary", "Cookie");
    response.status(200).json({ user: {
      id: user.id, name: user.name, email: user.email, role: user.role, status: user.status,
    }, csrfToken: csrfTokenForSession(token, csrfSecret) });
  });
  if (pendingUsers && appOrigin) {
    router.post("/admin/users", createRequireSession(reader), createRequireRoles(["ADMIN"]),
      createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
        try {
          const parsed = pendingUserSchema.safeParse(request.body);
          if (!parsed.success) {
            throw new ApplicationError(422, "VALIDATION_ERROR", "Entrada inválida", "Los datos de la solicitud no son válidos.");
          }
          const actor = response.locals["authUser"] as InternalUser;
          const user = await pendingUsers.create(actor.id, {
            name: parsed.data.name, email: parsed.data.email.trim().toLowerCase(), role: parsed.data.role,
          });
          response.set("Cache-Control", "no-store").status(201).json(user);
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
            next(new ApplicationError(409, "USER_CONFLICT", "Conflicto", "La cuenta no pudo crearse."));
          } else next(error);
        }
      });
  }
  return router;
}

function authFailure(reason: "invalid" | "limited", response: import("express").Response): ApplicationError {
  if (reason === "limited") {
    response.set("Retry-After", "900");
    return new ApplicationError(429, "TOO_MANY_ATTEMPTS", "Demasiados intentos", "Intente más tarde.");
  }
  return new ApplicationError(401, "AUTH_REQUIRED", "Autenticación requerida", "Las credenciales no son válidas.");
}
