import type { RequestHandler } from "express";

import {
  authenticateSession,
  authRequired,
  requireRole,
} from "../../../modules/identity/session-authentication.js";
import type { InternalRole, InternalUser, SessionReader } from "../../../modules/identity/session-reader.js";

export function createRequireSession(reader: SessionReader): RequestHandler {
  return async (request, response, next) => {
    try {
      response.locals["authUser"] = await authenticateSession(request.header("cookie"), reader);
      next();
    } catch (error) { next(error); }
  };
}

export function createRequireRoles(allowed: readonly InternalRole[]): RequestHandler {
  return (_request, response, next) => {
    const user = response.locals["authUser"] as InternalUser | undefined;
    try {
      if (!user) throw authRequired();
      requireRole(user, allowed);
      next();
    } catch (error) { next(error); }
  };
}
