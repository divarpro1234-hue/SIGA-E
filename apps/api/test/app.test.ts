import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createApp } from "../src/app.js";
import { createErrorHandler } from "../src/presentation/http/middleware/error-handler.js";
import { requestContext } from "../src/presentation/http/middleware/request-context.js";

let temporaryWebDirectory: string | undefined;

afterAll(async () => {
  if (temporaryWebDirectory) await rm(temporaryWebDirectory, { recursive: true, force: true });
});

describe("base HTTP de la API", () => {
  it("responde el health check definido por OpenAPI", async () => {
    const response = await request(createApp()).get("/api/v1/health");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["x-request-id"]).toEqual(expect.any(String));
  });

  it("usa la IP derivada por Express al confiar exactamente en el proxy configurado", async () => {
    const login = vi.fn(async () => ({
      ok: false as const,
      reason: "invalid" as const,
    }));
    const app = createApp({
      production: true,
      sessionReader: {
        async findByTokenHash() { return null; },
        async touchIfActive() { return false; },
      },
      csrfSecret: new Uint8Array(32).fill(1),
      appOrigin: "https://sigae.example.invalid",
      loginService: { login, async verify() { return { ok: false as const, reason: "invalid" as const }; }, async logout() {} },
    });

    await request(app).post("/api/v1/auth/login")
      .set("X-Forwarded-Proto", "https")
      .set("X-Forwarded-For", "203.0.113.10")
      .send({ email: "author@example.invalid", password: "synthetic-only" });

    expect(login).toHaveBeenCalledWith("author@example.invalid", "synthetic-only", "203.0.113.10");
  });

  it("normaliza rutas desconocidas como Problem Details", async () => {
    const response = await request(createApp()).get("/api/v1/no-existe");

    expect(response.status).toBe(404);
    expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({
      status: 404,
      code: "ROUTE_NOT_FOUND",
      title: "Recurso no encontrado",
    });
    expect(response.body.requestId).toEqual(expect.any(String));
  });

  it("no expone detalles internos de errores desconocidos", async () => {
    const reportError = vi.fn();
    const app = express();

    app.use(requestContext);
    app.get("/prueba-error", () => {
      throw new Error("detalle-interno-no-publicable");
    });
    app.use(createErrorHandler(reportError));

    const response = await request(app).get("/prueba-error");

    expect(response.status).toBe(500);
    expect(response.body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(response.body)).not.toContain("detalle-interno-no-publicable");
    expect(reportError).toHaveBeenCalledOnce();
  });

  it("sirve rutas SPA solo por HTTPS y conserva cabeceras seguras en producción", async () => {
    temporaryWebDirectory = await mkdtemp(join(tmpdir(), "sigae-render-web-"));
    await writeFile(join(temporaryWebDirectory, "index.html"), "<!doctype html><title>SIGA-E test</title>");
    const app = createApp({
      production: true,
      webDistDirectory: temporaryWebDirectory,
      appOrigin: "https://sigae.example.invalid",
    });

    expect(app.get("trust proxy")).toBe(1);
    const redirect = await request(app).get("/verificar").set("Accept", "text/html");
    expect(redirect.status).toBe(308);
    expect(redirect.headers.location).toBe("https://sigae.example.invalid/verificar");

    const page = await request(app).get("/verificar").set("X-Forwarded-Proto", "https").set("Accept", "text/html");
    expect(page.status).toBe(200);
    expect(page.text).toContain("SIGA-E test");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
    expect(page.headers["content-security-policy"]).toMatch(/script-src 'self'(?:;|$)/u);
    expect(page.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");

    const health = await request(app).get("/api/v1/health");
    expect(health.status).toBe(200);

    const unknownApi = await request(app).get("/api/v1/no-existe")
      .set("X-Forwarded-Proto", "https").set("Accept", "text/html");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.headers["content-type"]).toMatch(/^application\/problem\+json/u);
  });
});
