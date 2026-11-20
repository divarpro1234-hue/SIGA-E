import { Router, type RequestHandler, type Router as ExpressRouter } from "express";
import { ApplicationError } from "../../../domain/errors/application-error.js";
import type { PublicAlertApplicationService } from "../../../modules/public/public-alert-service.js";

const invalidQuery = () => new ApplicationError(
  422, "INVALID_ALERT_PAYLOAD", "Entrada inválida", "La consulta no es válida.",
);

function parsePositiveInteger(value: unknown, fallback: number, maximum?: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) throw invalidQuery();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (maximum !== undefined && parsed > maximum)) {
    throw invalidQuery();
  }
  return parsed;
}

function asyncHandler(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export function createPublicAlertRouter(service: PublicAlertApplicationService): ExpressRouter {
  const router = Router();
  router.use((_request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/alerts", asyncHandler(async (request, response) => {
    const query = request.query;
    if (Object.keys(query).some((key) => key !== "page" && key !== "limit")) throw invalidQuery();
    const page = parsePositiveInteger(query["page"], 1);
    const limit = parsePositiveInteger(query["limit"], 20, 50);
    response.status(200).json(await service.list(page, limit));
  }));

  router.get("/alerts/:id/anchor", asyncHandler(async (request, response) => {
    const id = request.params["id"];
    response.status(200).json(await service.anchor(typeof id === "string" ? id : ""));
  }));

  router.get("/alerts/:id", asyncHandler(async (request, response) => {
    const id = request.params["id"];
    response.status(200).json(await service.get(typeof id === "string" ? id : ""));
  }));

  router.get("/jwks", asyncHandler(async (_request, response) => {
    response.status(200).json(await service.jwks());
  }));

  router.get("/trust", asyncHandler(async (_request, response) => {
    response.status(200).json(await service.trust());
  }));

  return router;
}
