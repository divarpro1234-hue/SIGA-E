import { createHash, randomBytes } from "node:crypto";

import request from "supertest";
import express from "express";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import { ApplicationError } from "../../src/domain/errors/application-error.js";
import {
  authenticateSession,
  csrfTokenForSession,
  readSessionCookie,
  requireRole,
  validCsrfToken,
} from "../../src/modules/identity/session-authentication.js";
import type { InternalUser, SessionReader, StoredSession } from "../../src/modules/identity/session-reader.js";
import { createRequireRoles, createRequireSession } from "../../src/presentation/http/middleware/identity-authorization.js";
import { createErrorHandler } from "../../src/presentation/http/middleware/error-handler.js";

const token = randomBytes(32).toString("base64url");
const user: InternalUser = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Operador de prueba",
  email: "operador@example.invalid",
  role: "APPROVER",
  status: "ACTIVE",
};
const future = new Date("2030-01-01T00:00:00.000Z");
const now = new Date("2026-10-12T00:00:00.000Z");
const recent = new Date("2026-10-11T23:59:00.000Z");
const csrfSecret = new Uint8Array(32).fill(17);

function readerFor(session: StoredSession | null): SessionReader {
  return {
    async findByTokenHash(hash) {
      expect(Buffer.from(hash).equals(createHash("sha256").update(token, "ascii").digest())).toBe(true);
      return session;
    },
    async touchIfActive() { return true; },
  };
}

describe("M1 sesiones opacas y RBAC", () => {
  it("liga CSRF a la cookie y rechaza otro token", () => {
    const csrf = csrfTokenForSession(token, csrfSecret);
    expect(validCsrfToken(token, csrf, csrfSecret)).toBe(true);
    expect(validCsrfToken(randomBytes(32).toString("base64url"), csrf, csrfSecret)).toBe(false);
    expect(validCsrfToken(token, "invalido", csrfSecret)).toBe(false);
  });

  it("rechaza la sesión si el toque condicional detecta revocación concurrente", async () => {
    const active = { user, expiresAt: future, revokedAt: null, lastSeenAt: recent };
    const reader: SessionReader = {
      async findByTokenHash() { return active; },
      async touchIfActive() { return false; },
    };
    await expect(authenticateSession(`sigae_session=${token}`, reader, now))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });
  it("rechaza cookie ausente, duplicada o de formato inválido antes de consultar repositorio", async () => {
    expect(readSessionCookie(undefined)).toBeNull();
    expect(readSessionCookie(`sigae_session=${token}; sigae_session=${token}`)).toBeNull();
    expect(readSessionCookie("sigae_session=valor-invalido")).toBeNull();
    const reader: SessionReader = {
      async findByTokenHash() { throw new Error("No debe consultarse"); },
      async touchIfActive() { throw new Error("No debe consultarse"); },
    };
    await expect(authenticateSession(undefined, reader, now)).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    await expect(authenticateSession(`sigae_session=${token}; sigae_session=${token}`, reader, now))
      .rejects.toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("admite únicamente sesión activa, vigente y no revocada", async () => {
    const valid = { user, expiresAt: future, revokedAt: null, lastSeenAt: recent };
    await expect(authenticateSession(`otro=x; sigae_session=${token}`, readerFor(valid), now)).resolves.toEqual(user);
    for (const session of [
      null,
      { ...valid, expiresAt: now },
      { ...valid, revokedAt: now },
      { ...valid, lastSeenAt: new Date("2026-10-11T23:30:00.000Z") },
      { ...valid, user: { ...user, status: "PENDING_ENROLLMENT" as const } },
      { ...valid, user: { ...user, status: "DISABLED" as const } },
    ]) {
      await expect(authenticateSession(`sigae_session=${token}`, readerFor(session), now))
        .rejects.toMatchObject({ status: 401, code: "AUTH_REQUIRED" });
    }
  });

  it("aplica roles desde la identidad de backend", () => {
    expect(() => requireRole(user, ["APPROVER"])).not.toThrow();
    expect(() => requireRole(user, ["AUTHOR", "ADMIN"])).toThrow(ApplicationError);
    try { requireRole(user, ["AUTHOR"]); }
    catch (error) { expect(error).toMatchObject({ status: 403, code: "ROLE_FORBIDDEN" }); }
    for (const role of ["AUTHOR", "APPROVER", "ADMIN"] as const) {
      expect(() => requireRole({ ...user, role }, [role])).not.toThrow();
      for (const other of ["AUTHOR", "APPROVER", "ADMIN"] as const) {
        if (other !== role) expect(() => requireRole({ ...user, role }, [other])).toThrow(ApplicationError);
      }
    }
  });

  it("GET /api/v1/auth/me responde solo con los campos públicos del usuario", async () => {
    const session = { user: { ...user, passwordHash: "NO_PUBLICAR" }, expiresAt: future, revokedAt: null, lastSeenAt: new Date() };
    const app = createApp({ sessionReader: readerFor(session), csrfSecret });
    const response = await request(app).get("/api/v1/auth/me").set("Cookie", `sigae_session=${token}`);
    expect(response.status).toBe(200);
    expect(response.body.user).toEqual(user);
    expect(response.body.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["vary"]).toBe("Cookie");
    expect(response.text).not.toContain("NO_PUBLICAR");
  });

  it("GET /api/v1/auth/me no expone existencia de cuentas ni tokens", async () => {
    const app = createApp({ sessionReader: {
      async findByTokenHash() { return null; }, async touchIfActive() { return false; },
    }, csrfSecret });
    const response = await request(app).get("/api/v1/auth/me");
    expect(response.status).toBe(401);
    expect(response.body).toMatchObject({ code: "AUTH_REQUIRED" });
    expect(response.text).not.toContain(token);
  });

  it("middleware RBAC rechaza otro rol y solicitudes sin sesión", async () => {
    const app = express();
    app.get("/author", createRequireSession(readerFor({ user, expiresAt: future, revokedAt: null, lastSeenAt: new Date() })),
      createRequireRoles(["AUTHOR"]), (_request, response) => response.sendStatus(204));
    app.use(createErrorHandler(() => undefined));
    const wrongRole = await request(app).get("/author").set("Cookie", `sigae_session=${token}`);
    expect(wrongRole.status).toBe(403);
    expect(wrongRole.body).toMatchObject({ code: "ROLE_FORBIDDEN" });
    const anonymous = await request(app).get("/author");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body).toMatchObject({ code: "AUTH_REQUIRED" });
  });
});
