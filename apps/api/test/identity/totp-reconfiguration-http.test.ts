import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { TotpReconfigurationService } from "../../src/modules/identity/totp-reconfiguration.js";
import type { InternalUser, SessionReader } from "../../src/modules/identity/session-reader.js";

const origin = "https://sigae.example.invalid";
const secret = new Uint8Array(32).fill(53);
const token = "A".repeat(43);
const user: InternalUser = {
  id: "00000000-0000-4000-8000-000000000001", name: "Autor ficticio",
  email: "autor@example.invalid", role: "AUTHOR", status: "ACTIVE",
};
const reader: SessionReader = {
  async findByTokenHash() {
    return { user, expiresAt: new Date(Date.now() + 60_000), revokedAt: null,
      lastSeenAt: new Date(Date.now() - 1_000) };
  },
  async touchIfActive() { return true; },
};

describe("HTTP de reconfiguración TOTP M1", () => {
  it("protege inicio y confirmación con sesión, Origin y CSRF", async () => {
    const service: TotpReconfigurationService = {
      start: vi.fn(async () => ({
        reconfigureToken: "B".repeat(43),
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        otpauthUri: "otpauth://totp/fixture?secret=NO_REAL",
      })),
      confirm: vi.fn(async () => undefined),
    };
    const app = createApp({
      sessionReader: reader, csrfSecret: secret, appOrigin: origin,
      totpReconfigurationService: service,
    });
    const csrf = csrfTokenForSession(token, secret);
    const noCsrf = await request(app).post("/api/v1/auth/totp/reconfigure/start")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin)
      .send({ password: "Clave ficticia", currentCode: "123456" });
    expect(noCsrf.status).toBe(403);
    const started = await request(app).post("/api/v1/auth/totp/reconfigure/start")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin)
      .set("X-CSRF-Token", csrf).send({ password: "Clave ficticia", currentCode: "123456" });
    expect(started.status).toBe(200);
    expect(started.headers["cache-control"]).toBe("no-store");
    expect(started.headers["referrer-policy"]).toBe("no-referrer");
    expect(started.body.reconfigureToken).toHaveLength(43);
    const confirmed = await request(app).post("/api/v1/auth/totp/reconfigure/confirm")
      .set("Cookie", `sigae_session=${token}`).set("Origin", origin)
      .set("X-CSRF-Token", csrf)
      .send({ reconfigureToken: "B".repeat(43), newCode: "654321" });
    expect(confirmed.status).toBe(204);
    expect(service.start).toHaveBeenCalledWith(user.id, "Clave ficticia", "123456", expect.any(String));
    expect(service.confirm).toHaveBeenCalledWith(user.id, "B".repeat(43), "654321");
  });

  it("rechaza un origen incorrecto antes de invocar el servicio", async () => {
    const service: TotpReconfigurationService = {
      start: vi.fn(), confirm: vi.fn(),
    };
    const app = createApp({
      sessionReader: reader, csrfSecret: secret, appOrigin: origin,
      totpReconfigurationService: service,
    });
    const response = await request(app).post("/api/v1/auth/totp/reconfigure/start")
      .set("Cookie", `sigae_session=${token}`).set("Origin", "https://otro.example.invalid")
      .set("X-CSRF-Token", csrfTokenForSession(token, secret))
      .send({ password: "Clave ficticia", currentCode: "123456" });
    expect(response.status).toBe(403);
    expect(service.start).not.toHaveBeenCalled();
  });
});
