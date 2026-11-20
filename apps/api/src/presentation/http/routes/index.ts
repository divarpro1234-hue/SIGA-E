import { Router, type Router as ExpressRouter } from "express";

import { healthRouter } from "./health-routes.js";

export const apiV1Router: ExpressRouter = Router();

apiV1Router.use(healthRouter);
