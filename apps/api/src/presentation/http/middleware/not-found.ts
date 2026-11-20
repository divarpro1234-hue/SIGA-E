import type { RequestHandler } from "express";

import { ApplicationError } from "../../../domain/errors/application-error.js";

export const notFound: RequestHandler = (_request, _response, next) => {
  next(
    new ApplicationError(
      404,
      "ROUTE_NOT_FOUND",
      "Recurso no encontrado",
      "La ruta solicitada no existe.",
    ),
  );
};
