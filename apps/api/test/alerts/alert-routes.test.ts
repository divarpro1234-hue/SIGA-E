import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import { ApplicationError } from "../../src/domain/errors/application-error.js";
import type { DraftAlertService } from "../../src/modules/alerts/alert-draft-service.js";
import { csrfTokenForSession } from "../../src/modules/identity/session-authentication.js";
import type { InternalRole, InternalUser, SessionReader } from "../../src/modules/identity/session-reader.js";
import type { AlertDiagnosticReporter } from "../../src/presentation/http/diagnostic-reporting.js";
import { input } from "./alert-fixtures.js";

const id = "00000000-0000-4000-8000-000000000001";
const origin = "https://sigae.example.invalid";
const secret = new Uint8Array(32).fill(7);
const token = "A".repeat(43);
const cookie = `sigae_session=${token}`;
const csrf = csrfTokenForSession(token, secret);
const summary = { id, identifier: "SIGAE-DEMO-1", lifecycleState: "DRAFT", anchorStatus: "NOT_REQUESTED", notice: "SIMULACRO" as const };

function fixture(role: InternalRole = "AUTHOR", alertDiagnosticReporter?: AlertDiagnosticReporter) {
  const user: InternalUser = { id: "00000000-0000-4000-8000-000000000002", name: "Persona ficticia",
    email: "person@example.invalid", role, status: "ACTIVE" };
  const reader: SessionReader = { async findByTokenHash() { return { user,
    expiresAt: new Date(Date.now() + 60_000), revokedAt: null, lastSeenAt: new Date(Date.now() - 1000) }; },
  async touchIfActive() { return true; } };
  const service: DraftAlertService = { create: vi.fn().mockResolvedValue({ alert: summary, version: 1 }),
    list: vi.fn().mockResolvedValue({ items: [summary], page: 1, total: 1 }),
    get: vi.fn().mockResolvedValue({ alert: { ...summary, version: 1, kind: "Alert", info: input.info }, version: 1 }),
    anchor: vi.fn().mockResolvedValue({
      anchorStatus: "NOT_REQUESTED", network: null, contractId: null, txHash: null,
      confirmedLedger: null, digestVerification: "NOT_CHECKED", checkedAt: null,
      unavailableReason: "M5_DISABLED",
    }),
    audit: vi.fn().mockResolvedValue({ items: [] }),
    edit: vi.fn().mockResolvedValue({ alert: summary, version: 2 }),
    submit: vi.fn().mockResolvedValue({ lifecycleState: "READY_TO_SIGN", version: 2, payloadDigestHex: "0".repeat(64) }),
    approve: vi.fn().mockResolvedValue({ alert: { ...summary, lifecycleState: "READY_TO_SIGN" }, version: 3 }),
    reject: vi.fn().mockResolvedValue({ alert: { ...summary, lifecycleState: "REJECTED" }, version: 3 }),
    issue: vi.fn().mockResolvedValue({ alertId: id, lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "PENDING" }),
  };
  const app = createApp({ sessionReader: reader, csrfSecret: secret, appOrigin: origin,
    alertDraftService: service,
    ...(alertDiagnosticReporter ? { alertDiagnosticReporter } : {}) });
  return { app, service, user };
}

describe("API segura de borradores con servicio simulado", () => {
  it("exige sesión MFA y oculta caché también en errores", async () => {
    const { app, service } = fixture();
    const response = await request(app).get("/api/v1/alerts");
    expect(response.status).toBe(401);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.list).not.toHaveBeenCalled();
  });

  it("limita la lectura de evidencia de anclaje a ADMIN", async () => {
    const admin = fixture("ADMIN");
    const response = await request(admin.app).get(`/api/v1/alerts/${id}/anchor`).set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      anchorStatus: "NOT_REQUESTED",
      network: null,
      contractId: null,
      txHash: null,
      confirmedLedger: null,
      digestVerification: "NOT_CHECKED",
      checkedAt: null,
      unavailableReason: "M5_DISABLED",
    });
    expect(admin.service.anchor).toHaveBeenCalledWith(admin.user, id);

    for (const role of ["AUTHOR", "APPROVER"] as const) {
      const unauthorized = fixture(role);
      const denied = await request(unauthorized.app).get(`/api/v1/alerts/${id}/anchor`).set("Cookie", cookie);
      expect(denied.status).toBe(403);
      expect(unauthorized.service.anchor).not.toHaveBeenCalled();
    }

    const anonymous = fixture("ADMIN");
    const unauthenticated = await request(anonymous.app).get(`/api/v1/alerts/${id}/anchor`);
    expect(unauthenticated.status).toBe(401);
    expect(anonymous.service.anchor).not.toHaveBeenCalled();
  });

  it("crea solo con rol AUTHOR, Origin y CSRF válidos", async () => {
    const { app, service, user } = fixture();
    const missing = await request(app).post("/api/v1/alerts").set("Cookie", cookie).send(input);
    expect(missing.status).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
    const created = await request(app).post("/api/v1/alerts").set("Cookie", cookie)
      .set("Origin", origin).set("X-CSRF-Token", csrf).send(input);
    expect(created.status).toBe(201);
    expect(created.headers.etag).toBe('"v1"');
    expect(created.headers["cache-control"]).toBe("no-store");
    expect(created.body).toEqual(summary);
    expect(service.create).toHaveBeenCalledWith(user, cookie, input, expect.any(String));
    for (const role of ["APPROVER", "ADMIN"] as const) {
      const forbidden = fixture(role);
      const blocked = await request(forbidden.app).post("/api/v1/alerts").set("Cookie", cookie)
        .set("Origin", origin).set("X-CSRF-Token", csrf).send(input);
      expect(blocked.status).toBe(403);
      expect(forbidden.service.create).not.toHaveBeenCalled();
    }
    const wrongOrigin = await request(app).post("/api/v1/alerts").set("Cookie", cookie)
      .set("Origin", "https://wrong.example.invalid").set("X-CSRF-Token", csrf).send(input);
    expect(wrongOrigin.status).toBe(403);
  });

  it("recorre create, listado paginado, lectura propia y submit usando respuestas reales del adaptador", async () => {
    const { app, service, user } = fixture();
    vi.mocked(service.list).mockResolvedValueOnce({ items: [summary], page: 2, total: 5 });
    const created = await request(app).post("/api/v1/alerts").set("Cookie", cookie)
      .set("Origin", origin).set("X-CSRF-Token", csrf).send(input);
    expect(created.status).toBe(201);
    expect(created.body).toEqual(summary);
    expect(created.headers.etag).toBe('"v1"');

    const listed = await request(app).get("/api/v1/alerts?page=2&limit=10").set("Cookie", cookie);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual({ items: [summary], page: 2, total: 5 });
    expect(service.list).toHaveBeenCalledWith(user, 2, 10);

    const detail = await request(app).get(`/api/v1/alerts/${id}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ ...summary, version: 1, kind: "Alert", info: input.info });
    expect(detail.headers.etag).toBe('"v1"');
    expect(service.get).toHaveBeenCalledWith(user, id);

    const submitted = await request(app).post(`/api/v1/alerts/${id}/submit`).set("Cookie", cookie)
      .set("Origin", origin).set("X-CSRF-Token", csrf).send({ expectedVersion: detail.body.version });
    expect(submitted.status).toBe(200);
    expect(submitted.body).toEqual({ lifecycleState: "READY_TO_SIGN", payloadDigestHex: "0".repeat(64) });
    expect(submitted.headers.etag).toBe('"v2"');
    expect(service.submit).toHaveBeenCalledWith(user, cookie, id, 1);
  });

  it("oculta el detalle de una alerta ajena al AUTHOR con 404 saneado", async () => {
    const { app, service, user } = fixture();
    vi.mocked(service.get).mockRejectedValueOnce(
      new ApplicationError(404, "ALERT_NOT_FOUND", "No encontrada", "La alerta no está disponible."),
    );

    const response = await request(app).get(`/api/v1/alerts/${id}`).set("Cookie", cookie);

    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ALERT_NOT_FOUND");
    expect(response.body).not.toHaveProperty("info");
    expect(response.body).not.toHaveProperty("authorId");
    expect(service.get).toHaveBeenCalledWith(user, id);
  });

  it("entrega al APPROVER solo los campos de snapshot devueltos para una alerta ajena elegible", async () => {
    const { app, service, user } = fixture("APPROVER");
    const authorId = "00000000-0000-4000-8000-000000000003";
    const reviewDigest = "a".repeat(64);
    vi.mocked(service.get).mockResolvedValueOnce({
      alert: {
        ...summary, lifecycleState: "PENDING_APPROVAL", authorId, kind: "Alert", severity: "Severe",
        version: 4, reviewSnapshot: { payloadBase64Url: "eyJ4IjoxfQ", payloadDigestHex: reviewDigest },
      },
      version: 4,
    });

    const response = await request(app).get(`/api/v1/alerts/${id}`).set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"v4"');
    expect(response.body).toMatchObject({
      authorId, lifecycleState: "PENDING_APPROVAL", kind: "Alert", severity: "Severe", version: 4,
      reviewSnapshot: { payloadBase64Url: "eyJ4IjoxfQ", payloadDigestHex: reviewDigest },
    });
    expect(user.id).not.toBe(response.body.authorId);
    expect(service.get).toHaveBeenCalledWith(user, id);
  });

  it("emite con POST issue y exige AUTHOR, Origin, CSRF y digest estricto", async () => {
    const { app, service } = fixture();
    const body = { expectedDigestHex: "a".repeat(64) };
    const response = await request(app).post(`/api/v1/alerts/${id}/issue`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(body);

    expect(response.status).toBe(202);
    expect(response.body).toEqual({
      alertId: id, lifecycleState: "SIGNED_PENDING_ANCHOR", anchorStatus: "PENDING",
    });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(service.issue).toHaveBeenCalledWith(expect.objectContaining({ role: "AUTHOR" }), cookie, id, body);

    for (const role of ["APPROVER", "ADMIN"] as const) {
      const forbidden = fixture(role);
      const blocked = await request(forbidden.app).post(`/api/v1/alerts/${id}/issue`)
        .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(body);
      expect(blocked.status).toBe(403);
      expect(forbidden.service.issue).not.toHaveBeenCalled();
    }

    const invalid = await request(app).post(`/api/v1/alerts/${id}/issue`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .send({ ...body, expectedVersion: 1 });
    expect(invalid.status).toBe(422);
    expect(service.issue).toHaveBeenCalledTimes(1);
  });

  it("rechaza JSON sintácticamente malformado con Problem Details saneado", async () => {
    const reportDiagnostic = vi.fn();
    const { app, service } = fixture("AUTHOR", reportDiagnostic);
    const response = await request(app).post("/api/v1/alerts")
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .set("Content-Type", "application/json").send('{"kind":');

    expect(response.status).toBe(422);
    expect(response.headers["content-type"]).toMatch(/^application\/problem\+json/u);
    expect(response.body).toMatchObject({
      type: "about:blank",
      title: "Entrada inválida",
      status: 422,
      code: "INVALID_ALERT_PAYLOAD",
      detail: "La solicitud no es válida.",
    });
    expect(response.body).not.toHaveProperty("stack");
    expect(response.body).not.toHaveProperty("message");
    expect(service.create).not.toHaveBeenCalled();
    expect(reportDiagnostic).toHaveBeenCalledWith({
      requestId: response.headers["x-request-id"],
      stage: "JSON_PARSE",
      code: "INVALID_ALERT_PAYLOAD",
    });
    expect(JSON.stringify(reportDiagnostic.mock.calls[0])).not.toContain("kind");
  });

  it("página y límite no aceptan filtros ni valores ambiguos", async () => {
    const { app, service } = fixture();
    const good = await request(app).get("/api/v1/alerts?page=1&limit=20").set("Cookie", cookie);
    expect(good.status).toBe(200);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ role: "AUTHOR" }), 1, 20);
    for (const suffix of ["?page=0", "?page=1&page=2", "?limit=51", "?authorId=other", "?page=1.5"]) {
      const bad = await request(app).get(`/api/v1/alerts${suffix}`).set("Cookie", cookie);
      expect(bad.status).toBe(422);
      expect(bad.body.code).toBe("INVALID_ALERT_PAYLOAD");
    }
  });

  it("GET detalle entrega ETag y PATCH exige un único validador fuerte", async () => {
    const { app, service } = fixture();
    const detail = await request(app).get(`/api/v1/alerts/${id}`).set("Cookie", cookie);
    expect(detail.status).toBe(200);
    expect(detail.headers.etag).toBe('"v1"');
    for (const value of [undefined, "*", 'W/"v1"', '"v1","v2"', '"v0"']) {
      let pending = request(app).patch(`/api/v1/alerts/${id}`).set("Cookie", cookie)
        .set("Origin", origin).set("X-CSRF-Token", csrf);
      if (value) pending = pending.set("If-Match", value);
      const bad = await pending.send(input);
      expect(bad.status).toBe(422);
    }
    const tooLarge = await request(app).patch(`/api/v1/alerts/${id}`).set("Cookie", cookie)
      .set("Origin", origin).set("X-CSRF-Token", csrf).set("If-Match", '"v2147483648"').send(input);
    expect(tooLarge.status).toBe(409);
    expect(tooLarge.body.code).toBe("STALE_ALERT_VERSION");
    expect(service.edit).not.toHaveBeenCalled();
    const edited = await request(app).patch(`/api/v1/alerts/${id}`).set("Cookie", cookie)
      .set("Origin", origin).set("X-CSRF-Token", csrf).set("If-Match", '"v1"').send(input);
    expect(edited.status).toBe(200);
    expect(edited.headers.etag).toBe('"v2"');
    expect(service.edit).toHaveBeenCalledWith(expect.objectContaining({ role: "AUTHOR" }), cookie, id, 1, input);
  });

  it("envía una alerta crítica con expectedVersion, ETag y respuesta sin caché", async () => {
    const { app, service, user } = fixture();
    const response = await request(app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"v2"');
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ lifecycleState: "READY_TO_SIGN", payloadDigestHex: "0".repeat(64) });
    expect(service.submit).toHaveBeenCalledWith(user, cookie, id, 1);
  });

  it("devuelve 409 para un submit con versión obsoleta sin presentar éxito", async () => {
    const { app, service } = fixture();
    vi.mocked(service.submit).mockRejectedValueOnce(
      new ApplicationError(409, "STALE_ALERT_VERSION", "Conflicto", "La versión de la alerta cambió."),
    );

    const response = await request(app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .send({ expectedVersion: 1 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe("STALE_ALERT_VERSION");
    expect(response.body).not.toHaveProperty("lifecycleState");
    expect(service.submit).toHaveBeenCalledWith(expect.objectContaining({ role: "AUTHOR" }), cookie, id, 1);
  });

  it("expone approve/reject solo a APPROVER con CSRF, entrada estricta y ETag", async () => {
    const { app, service, user } = fixture("APPROVER");
    const approveBody = { expectedDigestHex: "a".repeat(64), expectedVersion: 2 };
    const approved = await request(app).post(`/api/v1/alerts/${id}/approve`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(approveBody);
    expect(approved.status).toBe(200);
    expect(approved.headers.etag).toBe('"v3"');
    expect(approved.headers["cache-control"]).toBe("no-store");
    expect(approved.body.lifecycleState).toBe("READY_TO_SIGN");
    expect(service.approve).toHaveBeenCalledWith(user, cookie, id, approveBody);

    const rejectBody = { reason: "Contenido incorrecto", expectedDigestHex: "b".repeat(64), expectedVersion: 2 };
    const rejected = await request(app).post(`/api/v1/alerts/${id}/reject`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(rejectBody);
    expect(rejected.status).toBe(200);
    expect(rejected.headers.etag).toBe('"v3"');
    expect(rejected.body.lifecycleState).toBe("REJECTED");
    expect(service.reject).toHaveBeenCalledWith(user, cookie, id, rejectBody);

    for (const role of ["AUTHOR", "ADMIN"] as const) {
      const forbidden = fixture(role);
      const response = await request(forbidden.app).post(`/api/v1/alerts/${id}/approve`)
        .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(approveBody);
      expect(response.status).toBe(403);
      expect(forbidden.service.approve).not.toHaveBeenCalled();
    }
    const invalid = await request(app).post(`/api/v1/alerts/${id}/approve`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .send({ ...approveBody, reason: "extra" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("INVALID_ALERT_PAYLOAD");
    expect(service.approve).toHaveBeenCalledOnce();
  });

  it("bloquea approve/reject sin sesión o sin Origin/CSRF", async () => {
    const anonymous = fixture("APPROVER");
    for (const operation of ["approve", "reject"] as const) {
      const response = await request(anonymous.app).post(`/api/v1/alerts/${id}/${operation}`)
        .set("Origin", origin).set("X-CSRF-Token", csrf)
        .send({ expectedDigestHex: "a".repeat(64), expectedVersion: 2,
          ...(operation === "reject" ? { reason: "Motivo válido" } : {}) });
      expect(response.status).toBe(401);
      expect(anonymous.service[operation]).not.toHaveBeenCalled();
    }

    const authenticated = fixture("APPROVER");
    const body = { expectedDigestHex: "a".repeat(64), expectedVersion: 2 };
    const wrongOrigin = await request(authenticated.app).post(`/api/v1/alerts/${id}/approve`)
      .set("Cookie", cookie).set("Origin", "https://wrong.example.invalid")
      .set("X-CSRF-Token", csrf).send(body);
    expect(wrongOrigin.status).toBe(403);
    const noCsrf = await request(authenticated.app).post(`/api/v1/alerts/${id}/reject`)
      .set("Cookie", cookie).set("Origin", origin)
      .send({ ...body, reason: "Motivo válido" });
    expect(noCsrf.status).toBe(403);
    expect(authenticated.service.approve).not.toHaveBeenCalled();
    expect(authenticated.service.reject).not.toHaveBeenCalled();
  });

  it("propaga la prohibición de autoaprobación sin responder con éxito", async () => {
    const { app, service, user } = fixture("APPROVER");
    const body = { expectedDigestHex: "a".repeat(64), expectedVersion: 2 };
    vi.mocked(service.approve).mockRejectedValueOnce(
      new ApplicationError(403, "SELF_APPROVAL_FORBIDDEN", "Operación no autorizada", "El autor no puede aprobar."),
    );

    const response = await request(app).post(`/api/v1/alerts/${id}/approve`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(body);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe("SELF_APPROVAL_FORBIDDEN");
    expect(response.body).not.toHaveProperty("lifecycleState");
    expect(service.approve).toHaveBeenCalledWith(user, cookie, id, body);
  });

  it("propaga PENDING_APPROVAL sin exigir If-Match", async () => {
    const { app, service } = fixture();
    vi.mocked(service.submit).mockResolvedValueOnce({
      lifecycleState: "PENDING_APPROVAL", version: 7, payloadDigestHex: "a".repeat(64),
    });

    const response = await request(app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .set("If-Match", '"v1"').send({ expectedVersion: 6 });

    expect(response.status).toBe(200);
    expect(response.headers.etag).toBe('"v7"');
    expect(response.body).toEqual({ lifecycleState: "PENDING_APPROVAL", payloadDigestHex: "a".repeat(64) });
    expect(service.submit).toHaveBeenCalledWith(expect.objectContaining({ role: "AUTHOR" }), cookie, id, 6);
  });

  it.each([
    {},
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { expectedVersion: "1" },
    { expectedVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expectedVersion: 1, submitAt: "2026-10-21T13:00:00.000Z" },
    { expectedVersion: 1, authorId: "00000000-0000-4000-8000-000000000003" },
    { expectedVersion: 1, payload: {} },
    { expectedVersion: 1, digest: "a".repeat(64) },
    { expectedVersion: 1, signature: "fake" },
  ])("rechaza cuerpo submit no estricto %#", async (body) => {
    const { app, service } = fixture();
    const response = await request(app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send(body);
    expect(response.status).toBe(422);
    expect(response.body.code).toBe("INVALID_ALERT_PAYLOAD");
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("no invoca submit sin autenticación, rol, Origin o CSRF válidos", async () => {
    const anonymous = fixture();
    const noSession = await request(anonymous.app).post(`/api/v1/alerts/${id}/submit`)
      .set("Origin", origin).set("X-CSRF-Token", csrf).send({ expectedVersion: 1 });
    expect(noSession.status).toBe(401);
    expect(anonymous.service.submit).not.toHaveBeenCalled();

    for (const role of ["APPROVER", "ADMIN"] as const) {
      const forbidden = fixture(role);
      const response = await request(forbidden.app).post(`/api/v1/alerts/${id}/submit`)
        .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf).send({ expectedVersion: 1 });
      expect(response.status).toBe(403);
      expect(forbidden.service.submit).not.toHaveBeenCalled();
    }

    const wrongOrigin = fixture();
    const originResponse = await request(wrongOrigin.app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", "https://wrong.example.invalid")
      .set("X-CSRF-Token", csrf).send({ expectedVersion: 1 });
    expect(originResponse.status).toBe(403);
    expect(wrongOrigin.service.submit).not.toHaveBeenCalled();

    const noCsrf = fixture();
    const csrfResponse = await request(noCsrf.app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", origin).send({ expectedVersion: 1 });
    expect(csrfResponse.status).toBe(403);
    expect(noCsrf.service.submit).not.toHaveBeenCalled();
  });

  it.each([
    [new ApplicationError(409, "STALE_ALERT_VERSION", "Conflicto", "La versión de la alerta cambió."), 409],
    [new ApplicationError(409, "INVALID_STATE_TRANSITION", "Conflicto", "La alerta no admite esta operación."), 409],
    [new ApplicationError(404, "ALERT_NOT_FOUND", "No encontrada", "La alerta no está disponible."), 404],
    [new ApplicationError(500, "INTERNAL_ERROR", "Error interno", "La solicitud no pudo completarse."), 500],
  ] as const)("sanea errores del servicio %#", async (error, status) => {
    const { app, service } = fixture();
    vi.mocked(service.submit).mockRejectedValueOnce(error);
    const response = await request(app).post(`/api/v1/alerts/${id}/submit`)
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .send({ expectedVersion: 1 });
    expect(response.status).toBe(status);
    expect(response.body.code).toBe(error.code);
    expect(response.body).not.toHaveProperty("stack");
    expect(response.body).not.toHaveProperty("message");
  });

  it("devuelve error contractual saneado para UUID inválido", async () => {
    const { app, service } = fixture();
    vi.mocked(service.submit).mockRejectedValueOnce(
      new ApplicationError(404, "ALERT_NOT_FOUND", "No encontrada", "La alerta no está disponible."),
    );
    const response = await request(app).post("/api/v1/alerts/not-a-uuid/submit")
      .set("Cookie", cookie).set("Origin", origin).set("X-CSRF-Token", csrf)
      .send({ expectedVersion: 1 });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("ALERT_NOT_FOUND");
    expect(service.submit).toHaveBeenCalledWith(expect.anything(), cookie, "not-a-uuid", 1);
  });
});
