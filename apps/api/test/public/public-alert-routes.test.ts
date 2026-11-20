import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/app.js";
import type { PublicAlertApplicationService } from "../../src/modules/public/public-alert-service.js";

const publicService: PublicAlertApplicationService = {
  list: vi.fn().mockResolvedValue({ items: [], page: 1, total: 0 }),
  get: vi.fn().mockResolvedValue({
    alert: {
      id: "00000000-0000-4000-8000-000000000001",
      identifier: "SIGAE-DEMO-0001",
      lifecycleState: "PUBLISHED",
      anchorStatus: "PENDING",
      notice: "SIMULACRO",
      sender: "urn:siga-e:simulacro",
      sent: "2026-10-20T14:32:00.000Z",
      status: "Exercise",
      scope: "Public",
    },
    jwsCompact: "header.payload.signature",
    signatureMeta: { alg: "ES256", kid: "trusted-test-key" },
    anchorEvidenceMeta: {
      network: "testnet",
      contractId: "C".repeat(56),
      anchorStatus: "PENDING",
      messageKeyHex: "a".repeat(64),
      jwsHashHex: "b".repeat(64),
      txHash: null,
      checkedAt: null,
      verificationSource: "backend_metadata",
      note: "Metadata del backend; no es una lectura independiente de Soroban.",
    },
  }),
  anchor: vi.fn().mockResolvedValue({
    network: "testnet",
    contractId: "C".repeat(56),
    anchorStatus: "PENDING",
    messageKeyHex: "a".repeat(64),
    jwsHashHex: "b".repeat(64),
    txHash: null,
    checkedAt: null,
    verificationSource: "backend_metadata",
    note: "Metadata del backend; no es una lectura independiente de Soroban.",
  }),
  jwks: vi.fn().mockResolvedValue({ keys: [] }),
  trust: vi.fn().mockResolvedValue({ trustedKeyThumbprints: [], network: "testnet" }),
};

describe("rutas públicas M4", () => {
  const app = createApp({ publicAlertService: publicService });

  it("permite listado público sin autenticación y desactiva caché", async () => {
    const response = await request(app).get("/api/v1/public/alerts?page=2&limit=5").expect(200);

    expect(response.body).toEqual({ items: [], page: 1, total: 0 });
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(publicService.list).toHaveBeenCalledWith(2, 5);
  });

  it("rechaza parámetros fuera del contrato de listado", async () => {
    await request(app).get("/api/v1/public/alerts?scenario=SISMO").expect(422);
    await request(app).get("/api/v1/public/alerts?limit=51").expect(422);
  });

  it("expone detalle, anclaje, JWKS y trust en las rutas de diseño", async () => {
    await request(app).get("/api/v1/public/alerts/00000000-0000-4000-8000-000000000001")
      .expect(200);
    await request(app).get("/api/v1/public/alerts/00000000-0000-4000-8000-000000000001/anchor")
      .expect(200);
    await request(app).get("/api/v1/public/jwks").expect(200);
    await request(app).get("/api/v1/public/trust").expect(200);
    expect(publicService.get).toHaveBeenCalledTimes(1);
    expect(publicService.anchor).toHaveBeenCalledTimes(1);
    expect(publicService.jwks).toHaveBeenCalledTimes(1);
    expect(publicService.trust).toHaveBeenCalledTimes(1);
  });
});
