import express from "express";
import { describe, expect, it } from "vitest";
import { csrfPost } from "./csrf-request.js";

describe("helper de solicitudes CSRF para M2 HTTP", () => {
  it("construye un POST válido y envía cookie, Origin y token CSRF", async () => {
    const app = express();
    app.post("/csrf-probe", (req, res) => {
      res.json({
        method: req.method,
        path: req.path,
        cookie: req.get("Cookie"),
        origin: req.get("Origin"),
        csrf: req.get("X-CSRF-Token"),
      });
    });

    const response = await csrfPost(
      app,
      { cookie: "sigae_session=offline-session", csrf: "offline-csrf-token" },
      "https://siga-e-m2-http.example.invalid",
      "/csrf-probe",
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      method: "POST",
      path: "/csrf-probe",
      cookie: "sigae_session=offline-session",
      origin: "https://siga-e-m2-http.example.invalid",
      csrf: "offline-csrf-token",
    });
  });
});
