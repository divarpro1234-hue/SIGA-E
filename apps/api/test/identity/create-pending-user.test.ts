import { randomBytes } from "node:crypto";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { PendingUserService } from "../../src/modules/identity/create-pending-user.js";
import type { InternalUser, SessionReader } from "../../src/modules/identity/session-reader.js";

const token = randomBytes(32).toString("base64url");
const secret = new Uint8Array(32).fill(37);
const origin = "https://sigae.example.invalid";
const admin: InternalUser = {
  id: "00000000-0000-4000-8000-000000000001", name: "Admin ficticio",
  email: "admin@example.invalid", role: "ADMIN", status: "ACTIVE",
};
const pending: InternalUser = {
  id: "00000000-0000-4000-8000-000000000002", name: "Autor ficticio",
  email: "autor@example.invalid", role: "AUTHOR", status: "PENDING_ENROLLMENT",
};
const readerFor = (user: InternalUser): SessionReader => ({
  async findByTokenHash() { return {
    user, expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
    lastSeenAt: new Date(Date.now() - 1_000),
  }; },
  async touchIfActive() { return true; },
});

describe("POST /api/v1/admin/users", () => {
  it("crea únicamente cuenta pendiente con ADMIN, cookie, Origin y CSRF", async () => {
    const calls: unknown[] = [];
    const service: PendingUserService = { async create(actorId, input) { calls.push({ actorId, input }); return pending; } };
    const app = createApp({ sessionReader: readerFor(admin), csrfSecret: secret, appOrigin: origin, pendingUserService: service });
    const response = await request(app).post("/api/v1/admin/users")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin)
      .set("X-CSRF-Token", csrfTokenForSession(token, secret))
      .send({ name: "  Autor ficticio  ", email: "AUTOR@example.invalid", role: "AUTHOR" });
    expect(response.status).toBe(201);
    expect(response.body).toEqual(pending);
    expect(response.text).not.toMatch(/invitationToken|otpauthUri|qr/i);
    expect(calls).toEqual([{ actorId: admin.id, input: {
      name: "Autor ficticio", email: "autor@example.invalid", role: "AUTHOR",
    } }]);
  });

  it("rechaza rol, CSRF y entrada inválidos antes de escribir", async () => {
    let writes = 0;
    const service: PendingUserService = { async create() { writes += 1; return pending; } };
    const adminApp = createApp({ sessionReader: readerFor(admin), csrfSecret: secret, appOrigin: origin, pendingUserService: service });
    const authorApp = createApp({ sessionReader: readerFor({ ...admin, role: "AUTHOR" }), csrfSecret: secret, appOrigin: origin, pendingUserService: service });
    const body = { name: "Autor ficticio", email: "autor@example.invalid", role: "AUTHOR" };
    const forbidden = await request(authorApp).post("/api/v1/admin/users")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin)
      .set("X-CSRF-Token", csrfTokenForSession(token, secret)).send(body);
    expect(forbidden.status).toBe(403);
    const noCsrf = await request(adminApp).post("/api/v1/admin/users")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin).send(body);
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe("CSRF_INVALID");
    const invalid = await request(adminApp).post("/api/v1/admin/users")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin)
      .set("X-CSRF-Token", csrfTokenForSession(token, secret)).send({ ...body, role: "PUBLIC" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("VALIDATION_ERROR");
    expect(writes).toBe(0);
  });
});
