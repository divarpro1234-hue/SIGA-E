import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApp } from "../../src/app.js";
import type { LoginService } from "../../src/modules/identity/login-service.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { InternalUser, SessionReader } from "../../src/modules/identity/session-reader.js";

const origin = "https://sigae.example.invalid";
const secret = new Uint8Array(32).fill(41);
const token = "A".repeat(43);
const challengeId = "B".repeat(43);
const user: InternalUser = { id: "00000000-0000-4000-8000-000000000001", name: "Persona ficticia",
  email: "person@example.invalid", role: "AUTHOR", status: "ACTIVE" };
const reader: SessionReader = {
  async findByTokenHash() { return { user, expiresAt: new Date(Date.now() + 60_000),
    revokedAt: null, lastSeenAt: new Date(Date.now() - 1000) }; },
  async touchIfActive() { return true; },
};

describe("HTTP M1 principal", () => {
  it("no emite cookie tras contraseña; la emite tras TOTP y permite me/logout con CSRF", async () => {
    const calls: string[] = [];
    const service: LoginService = {
      async login() { calls.push("login"); return { ok: true, challengeId, expiresAt: new Date(Date.now() + 300_000).toISOString() }; },
      async verify() { calls.push("verify"); return { ok: true, token, user }; },
      async logout() { calls.push("logout"); },
    };
    const app = createApp({ sessionReader: reader, csrfSecret: secret, appOrigin: origin, loginService: service });
    const first = await request(app).post("/api/v1/auth/login").send({ email: user.email, password: "ficticia" });
    expect(first.status).toBe(200);
    expect(first.body.challengeId).toBe(challengeId);
    expect(first.headers["set-cookie"]).toBeUndefined();
    const second = await request(app).post("/api/v1/auth/totp/verify").send({ challengeId, code: "123456" });
    expect(second.status).toBe(200);
    expect(second.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    expect(second.headers["set-cookie"]?.[0]).toContain("Secure");
    expect(second.headers["set-cookie"]?.[0]).toContain("SameSite=Strict");
    expect(second.body.csrfToken).toBe(csrfTokenForSession(token, secret));
    const me = await request(app).get("/api/v1/auth/me").set("Cookie", `sigae_session=${token}`);
    expect(me.status).toBe(200);
    expect(me.headers["cache-control"]).toBe("no-store");
    const forbidden = await request(app).post("/api/v1/auth/logout").set("Cookie", `sigae_session=${token}`).set("Origin", origin);
    expect(forbidden.status).toBe(403);
    const logout = await request(app).post("/api/v1/auth/logout").set("Cookie", `sigae_session=${token}`)
      .set("Origin", origin).set("X-CSRF-Token", second.body.csrfToken);
    expect(logout.status).toBe(204);
    expect(logout.headers["set-cookie"]?.[0]).toContain("sigae_session=;");
    expect(calls).toEqual(["login", "verify", "logout"]);
  });

  it("normaliza 401 y 429 con Retry-After", async () => {
    const service: LoginService = {
      async login() { return { ok: false, reason: "invalid" }; },
      async verify() { return { ok: false, reason: "limited" }; },
      async logout() { throw new Error("No esperado"); },
    };
    const app = createApp({ sessionReader: reader, csrfSecret: secret, appOrigin: origin, loginService: service });
    const badPassword = await request(app).post("/api/v1/auth/login").send({ email: user.email, password: "incorrecta" });
    expect(badPassword.status).toBe(401);
    expect(badPassword.headers["content-type"]).toMatch(/application\/problem\+json/);
    const limited = await request(app).post("/api/v1/auth/totp/verify").send({ challengeId, code: "000000" });
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe("900");
  });
});
