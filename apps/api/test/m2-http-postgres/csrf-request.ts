import type { Express } from "express";
import request from "supertest";

interface CsrfActor {
  readonly cookie: string;
  readonly csrf: string;
}

export function csrfPost(
  app: Express,
  actor: CsrfActor,
  origin: string,
  path: string,
) {
  return request(app).post(path)
    .set("Cookie", actor.cookie)
    .set("Origin", origin)
    .set("X-CSRF-Token", actor.csrf);
}
