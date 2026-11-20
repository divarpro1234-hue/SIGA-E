import { Router, type Router as ExpressRouter } from "express";
import { ApplicationError } from "../../../domain/errors/application-error.js";
import type { DraftAlertService } from "../../../modules/alerts/alert-draft-service.js";
import { AlertDomainError, validateApproveInput, validateIssueInput, validateRejectInput, validateSubmitInput } from "../../../modules/alerts/alert-input.js";
import { MAX_ALERT_VERSION } from "../../../modules/alerts/alert-persistence.js";
import type { InternalUser, SessionReader } from "../../../modules/identity/session-reader.js";
import { createRequireSession, createRequireRoles } from "../middleware/identity-authorization.js";
import { createRequireCsrf } from "../middleware/csrf.js";

const invalidInput = () => new ApplicationError(422, "INVALID_ALERT_PAYLOAD", "Entrada inválida", "La solicitud no es válida.");
const etag = (version: number) => `"v${version}"`;

function pathId(value: string | string[] | undefined): string {
  if (typeof value !== "string") throw invalidInput();
  return value;
}

function queryNumber(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9][0-9]*$/u.test(value)) throw invalidInput();
  const result = Number(value);
  if (!Number.isSafeInteger(result)) throw invalidInput();
  return result;
}

function matchVersion(value: string | undefined): number {
  if (!value || !/^"v[1-9][0-9]*"$/u.test(value)) throw invalidInput();
  const version = BigInt(value.slice(2, -1));
  if (version > BigInt(MAX_ALERT_VERSION))
    throw new ApplicationError(409, "STALE_ALERT_VERSION", "Conflicto", "La versión de la alerta cambió.");
  return Number(version);
}

function submitInput(value: unknown): { expectedVersion: number } {
  try {
    return validateSubmitInput(value);
  } catch (error) {
    if (error instanceof AlertDomainError && error.code === "INVALID_ALERT_PAYLOAD") throw invalidInput();
    throw error;
  }
}

function decisionInput<T>(validate: (value: unknown) => T, value: unknown): T {
  try {
    return validate(value);
  } catch (error) {
    if (error instanceof AlertDomainError && error.code === "INVALID_ALERT_PAYLOAD") throw invalidInput();
    throw error;
  }
}

export function createAlertRouter(reader: SessionReader, csrfSecret: Uint8Array,
  appOrigin: string, service: DraftAlertService): ExpressRouter {
  const router = Router();
  router.use("/alerts", (_request, response, next) => {
    response.set("Cache-Control", "no-store").set("Vary", "Cookie");
    next();
  });
  router.post("/alerts", createRequireSession(reader), createRequireRoles(["AUTHOR"]),
    createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        const result = await service.create(actor, request.header("cookie"), request.body,
          response.locals["requestId"] as string);
        response.set("ETag", etag(result.version)).status(201).json(result.alert);
      } catch (error) { next(error); }
    });
  router.get("/alerts", createRequireSession(reader), createRequireRoles(["AUTHOR", "APPROVER", "ADMIN"]),
    async (request, response, next) => {
      try {
        if (Object.keys(request.query).some((key) => key !== "page" && key !== "limit")) throw invalidInput();
        const page = queryNumber(request.query["page"], 1);
        const limit = queryNumber(request.query["limit"], 20);
        if (limit > 50) throw invalidInput();
        const actor = response.locals["authUser"] as InternalUser;
        response.status(200).json(await service.list(actor, page, limit));
      } catch (error) { next(error); }
    });
  router.get("/alerts/:id", createRequireSession(reader), createRequireRoles(["AUTHOR", "APPROVER", "ADMIN"]),
    async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        const result = await service.get(actor, pathId(request.params["id"]));
        response.set("ETag", etag(result.version)).status(200).json(result.alert);
      } catch (error) { next(error); }
    });
  router.get("/alerts/:id/audit", createRequireSession(reader), createRequireRoles(["AUTHOR", "APPROVER", "ADMIN"]),
    async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        response.status(200).json(await service.audit(actor, pathId(request.params["id"])));
      } catch (error) { next(error); }
    });
  router.get("/alerts/:id/anchor", createRequireSession(reader), createRequireRoles(["ADMIN"]),
    async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        response.status(200).json(await service.anchor(actor, pathId(request.params["id"])));
      } catch (error) { next(error); }
    });
  router.patch("/alerts/:id", createRequireSession(reader), createRequireRoles(["AUTHOR"]),
    createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const version = matchVersion(request.header("If-Match"));
        const actor = response.locals["authUser"] as InternalUser;
        const result = await service.edit(actor, request.header("cookie"), pathId(request.params["id"]), version, request.body);
        response.set("ETag", etag(result.version)).status(200).json(result.alert);
      } catch (error) { next(error); }
    });
  router.post("/alerts/:id/submit", createRequireSession(reader), createRequireRoles(["AUTHOR"]),
    createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        const { expectedVersion } = submitInput(request.body);
        const result = await service.submit(actor, request.header("cookie"),
          pathId(request.params["id"]), expectedVersion);
        response.set("ETag", etag(result.version)).status(200).json({
          lifecycleState: result.lifecycleState,
          payloadDigestHex: result.payloadDigestHex,
        });
      } catch (error) { next(error); }
    });
  router.post("/alerts/:id/approve", createRequireSession(reader), createRequireRoles(["APPROVER"]),
    createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        const body = decisionInput(validateApproveInput, request.body);
        const result = await service.approve(actor, request.header("cookie"), pathId(request.params["id"]), body);
        response.set("ETag", etag(result.version)).status(200).json(result.alert);
      } catch (error) { next(error); }
    });
  router.post("/alerts/:id/reject", createRequireSession(reader), createRequireRoles(["APPROVER"]),
    createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        const body = decisionInput(validateRejectInput, request.body);
        const result = await service.reject(actor, request.header("cookie"), pathId(request.params["id"]), body);
        response.set("ETag", etag(result.version)).status(200).json(result.alert);
      } catch (error) { next(error); }
    });
  router.post("/alerts/:id/issue", createRequireSession(reader), createRequireRoles(["AUTHOR"]),
    createRequireCsrf(csrfSecret, appOrigin), async (request, response, next) => {
      try {
        const actor = response.locals["authUser"] as InternalUser;
        const body = decisionInput(validateIssueInput, request.body);
        const result = await service.issue(actor, request.header("cookie"), pathId(request.params["id"]), body);
        response.status(202).json(result);
      } catch (error) { next(error); }
    });
  return router;
}
