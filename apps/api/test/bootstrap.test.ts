import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoKey } from "jose";
import type { PrismaClient } from "../src/generated/prisma/client.js";
import type { createPrismaClient } from "../src/infrastructure/database/prisma-client.js";
import type { AlertSigner } from "../src/modules/signing/alert-signer.js";
import { createConfiguredApp } from "../src/bootstrap.js";

const captures = vi.hoisted(() => ({
  appOptions: [] as Array<Record<string, unknown>>,
  draftServiceArguments: [] as unknown[][],
  anchorWorkerConstructed: false,
}));

vi.mock("../src/app.js", () => ({
  createApp: vi.fn((options: Record<string, unknown>) => {
    captures.appOptions.push(options);
    return { mockedApp: true };
  }),
}));

vi.mock("../src/modules/alerts/alert-draft-service.js", () => ({
  PrismaDraftAlertService: class {
    constructor(...args: unknown[]) {
      captures.draftServiceArguments.push(args);
    }
  },
}));

vi.mock("../src/modules/identity/prisma-session-reader.js", () => ({
  PrismaSessionReader: class {},
}));
vi.mock("../src/modules/identity/create-pending-user.js", () => ({
  PrismaPendingUserService: class {},
}));
vi.mock("../src/modules/identity/login-service.js", () => ({
  PrismaLoginService: class {},
}));
vi.mock("../src/modules/identity/totp-reconfiguration.js", () => ({
  PrismaTotpReconfigurationService: class {},
}));
vi.mock("../src/modules/public/public-alert-service.js", () => ({
  PrismaPublicAlertService: class {},
}));
vi.mock("../src/modules/anchor/anchor-worker.js", () => ({
  PrismaAnchorWorker: class {
    constructor() {
      captures.anchorWorkerConstructed = true;
    }
  },
}));

const baseEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
  SESSION_SECRET: "s".repeat(32),
  APP_ORIGIN: "https://sigae.example.invalid",
};
const fakePrisma = {} as PrismaClient;
const fakeClientFactory = vi.fn(() => fakePrisma) as unknown as typeof createPrismaClient;

function createEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...baseEnvironment, ...overrides };
}

describe("composición de bootstrap M3", () => {
  beforeEach(() => {
    captures.appOptions.length = 0;
    captures.draftServiceArguments.length = 0;
    captures.anchorWorkerConstructed = false;
    vi.clearAllMocks();
  });

  it("mantiene el proveedor deshabilitado por defecto y no inicializa AnchorWorker", () => {
    const result = createConfiguredApp(createEnvironment(), fakeClientFactory);

    expect(result.environment.m3SigningEnabled).toBe(false);
    expect(captures.draftServiceArguments).toHaveLength(1);
    expect(captures.draftServiceArguments[0]).toHaveLength(6);
    expect(captures.draftServiceArguments[0]?.[5]).toBeUndefined();
    expect(captures.anchorWorkerConstructed).toBe(false);
  });

  it("no habilita escrituras M1 fuera del perfil estricto aunque DATABASE_URL sea loopback", () => {
    expect(() => createConfiguredApp(createEnvironment({
      DATABASE_URL: "postgresql://fixture_user:synthetic-password@127.0.0.1:55432/sigae_m2_http_itest",
      M1_WRITES_ENABLED: "true",
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    }), fakeClientFactory)).toThrow("SIGAE_M1_LAB");
  });

  it("habilita las escrituras M1 solo en el perfil y destino M1 estrictos", () => {
    const databaseUrl =
      "postgresql://fixture_user:synthetic-password@127.0.0.1:55432/sigae_m1_test";
    createConfiguredApp(createEnvironment({
      SIGAE_M1_LAB: "true",
      DATABASE_URL: databaseUrl,
      DIRECT_URL: databaseUrl,
      M1_WRITES_ENABLED: "true",
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    }), fakeClientFactory);

    expect(captures.appOptions[0]).toHaveProperty("pendingUserService");
    expect(captures.appOptions[0]).toHaveProperty("loginService");
    expect(captures.appOptions[0]).toHaveProperty("totpReconfigurationService");
  });

  it("habilita login y MFA de producción solo con el perfil M1 explícito", () => {
    const result = createConfiguredApp(createEnvironment({
      NODE_ENV: "production",
      HOST: undefined,
      DATABASE_URL: "postgresql://runtime:fixture@db.internal:5432/sigae?sslmode=require",
      SIGAE_M1_RENDER_ENABLED: "true",
      M1_WRITES_ENABLED: "true",
      SESSION_SECRET: Buffer.alloc(48, 83).toString("base64url"),
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    }), fakeClientFactory);

    expect(result.environment.host).toBe("0.0.0.0");
    expect(captures.appOptions[0]).toMatchObject({
      production: true,
      appOrigin: "https://sigae.example.invalid",
    });
    expect(captures.appOptions[0]).toHaveProperty("webDistDirectory");
    expect(captures.appOptions[0]).toHaveProperty("pendingUserService");
    expect(captures.appOptions[0]).toHaveProperty("loginService");
    expect(captures.appOptions[0]).toHaveProperty("totpReconfigurationService");
    expect(captures.anchorWorkerConstructed).toBe(false);
  });

  it("rechaza un perfil M1 incompleto antes de construir Prisma", () => {
    const factory = vi.fn(() => fakePrisma) as unknown as typeof createPrismaClient;
    expect(() => createConfiguredApp(createEnvironment({
      SIGAE_M1_LAB: "true",
      DATABASE_URL: "postgresql://test:test@127.0.0.1:55432/sigae_m1_test",
      DIRECT_URL: "postgresql://test:test@127.0.0.1:55432/sigae_m1_test",
      M1_WRITES_ENABLED: "true",
      APP_ORIGIN: "https://127.0.0.1:5173",
      SESSION_SECRET: undefined,
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    }), factory)).toThrow("SESSION_SECRET");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rechaza el perfil HTTP con la base Anchor Operator antes de construir Prisma", () => {
    const factory = vi.fn(() => fakePrisma) as unknown as typeof createPrismaClient;
    expect(() => createConfiguredApp(createEnvironment({
      SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: "anchor-operator-testnet-v1",
      DATABASE_URL: "postgresql://sigae_m5_anchor_operator:test@127.0.0.1:55432/sigae_m5_anchor_operator",
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    }), factory)).toThrow("variables de operador");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rechaza combinar el perfil HTTP M1 con el perfil PostgreSQL M5", () => {
    const factory = vi.fn(() => fakePrisma) as unknown as typeof createPrismaClient;
    expect(() => createConfiguredApp(createEnvironment({
      SIGAE_M1_LAB: "true",
      SIGAE_M5_ANCHOR_OPERATOR_LAB: "true",
      SIGAE_M5_ANCHOR_OPERATOR_LAB_ID: "anchor-operator-testnet-v1",
      DATABASE_URL: "postgresql://sigae_m5_anchor_operator:test@127.0.0.1:55432/sigae_m5_anchor_operator",
      DIRECT_URL: "postgresql://sigae_m5_anchor_operator:test@127.0.0.1:55432/sigae_m5_anchor_operator",
      M1_WRITES_ENABLED: "true",
      TOTP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64url"),
    }), factory)).toThrow();
    expect(factory).not.toHaveBeenCalled();
  });

  it("inyecta el proveedor solo con activación explícita y configuración completa", () => {
    const signer: AlertSigner = { kid: "test-kid", sign: vi.fn(async () => {
      throw new Error("El firmante de prueba no debe invocarse durante bootstrap.");
    }) };
    const trustedPublicKey = {
      type: "public", extractable: false,
      algorithm: { name: "ECDSA", namedCurve: "P-256" }, usages: ["verify"],
    } as CryptoKey;
    const provider = {
      getActiveSigner: vi.fn(() => signer),
      getTrustedPublicKey: vi.fn(() => trustedPublicKey),
    };
    const result = createConfiguredApp(createEnvironment({
      SIGAE_M3_SIGNING_ENABLED: "true",
      SESSION_SECRET: "s".repeat(32),
      APP_ORIGIN: "https://sigae.example.invalid",
    }), fakeClientFactory, { alertSigningKeyProvider: provider });

    expect(result.environment.m3SigningEnabled).toBe(true);
    expect(captures.draftServiceArguments[0]?.[5]).toBe(provider);
    expect(provider.getActiveSigner).not.toHaveBeenCalled();
    expect(signer.sign).not.toHaveBeenCalled();
    expect(captures.anchorWorkerConstructed).toBe(false);
  });

  it("falla antes de crear Prisma si la activación no tiene proveedor o configuración completa", () => {
    const enabled = createEnvironment({ SIGAE_M3_SIGNING_ENABLED: "true" });

    expect(() => createConfiguredApp(enabled, fakeClientFactory)).toThrow(
      "M3_SIGNING_CONFIGURATION_INCOMPLETE",
    );
    expect(fakeClientFactory).not.toHaveBeenCalled();

    const provider = { getActiveSigner: vi.fn(), getTrustedPublicKey: vi.fn() };
    expect(() => createConfiguredApp(createEnvironment(), fakeClientFactory, {
      alertSigningKeyProvider: provider,
    })).toThrow("M3_SIGNING_REQUIRES_EXPLICIT_ENABLEMENT");
    expect(fakeClientFactory).not.toHaveBeenCalled();

    expect(() => createConfiguredApp(createEnvironment({
      SIGAE_M3_SIGNING_ENABLED: "true",
      SESSION_SECRET: "s".repeat(32),
      APP_ORIGIN: undefined,
    }), fakeClientFactory, { alertSigningKeyProvider: provider })).toThrow(
      "M3_SIGNING_CONFIGURATION_INCOMPLETE",
    );
    expect(fakeClientFactory).not.toHaveBeenCalled();
  });

  it("rechaza una dependencia que no implementa el contrato de proveedor", () => {
    expect(() => createConfiguredApp(createEnvironment({
      SIGAE_M3_SIGNING_ENABLED: "true",
      SESSION_SECRET: "s".repeat(32),
      APP_ORIGIN: "https://sigae.example.invalid",
    }), fakeClientFactory, {
      alertSigningKeyProvider: {} as never,
    })).toThrow("M3_SIGNING_CONFIGURATION_INCOMPLETE");
    expect(fakeClientFactory).not.toHaveBeenCalled();
  });
});
