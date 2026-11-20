import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CryptoKey } from "jose";
import type { TrustedPublicKeyCatalog } from "../src/modules/signing/trusted-public-keys.js";
import type { LocalAlertSignerSource } from "../src/modules/signing/local-alert-signer-source.js";
import type { TrustedDotnetVerifierPolicy } from "../src/modules/signing/dotnet-verifier-bridge-channel.js";

const captures = vi.hoisted(() => ({
  calls: [] as unknown[][],
  listen: vi.fn(),
}));

vi.mock("../src/bootstrap.js", () => ({
  createConfiguredApp: vi.fn((...args: unknown[]) => {
    captures.calls.push(args);
    return {
      app: { listen: captures.listen },
      environment: { port: 3000, host: "127.0.0.1", m3SigningEnabled: false },
    };
  }),
}));

import { startServer } from "../src/server.js";

function fakePublicKey(): CryptoKey {
  return {
    type: "public",
    extractable: false,
    algorithm: { name: "ECDSA", namedCurve: "P-256" },
    usages: ["verify"],
  } as CryptoKey;
}

const environment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/sigae_test",
};

const dpapiPolicy: TrustedDotnetVerifierPolicy = {
  installationDirectory: "C:\\Program Files\\SIGA-E\\M3",
  executablePath: "C:\\Program Files\\SIGA-E\\M3\\Sigae.M3.DpapiSigner.exe",
  executableSha256: "a".repeat(64),
  assemblySha256: "b".repeat(64),
};

describe("entrada de servidor M3", () => {
  beforeEach(() => {
    captures.calls.length = 0;
    captures.listen.mockReset();
  });

  it("inicia normalmente sin fuente de firma cuando M3 está deshabilitado", () => {
    startServer({ environment });

    expect(captures.calls[0]?.[0]).toBe(environment);
    expect(captures.calls[0]?.[2]).toEqual({});
    expect(captures.listen).toHaveBeenCalledOnce();
  });

  it("compone una fuente inyectada sin cargarla durante el arranque", () => {
    const source: LocalAlertSignerSource = {
      getActiveSigner: vi.fn(() => {
        throw new Error("No debe cargarse al arrancar.");
      }),
    };
    const trustedKeys: TrustedPublicKeyCatalog = { resolve: vi.fn(() => fakePublicKey()) };

    startServer({
      environment: {
        ...environment,
        SIGAE_M3_SIGNING_ENABLED: "true",
        SESSION_SECRET: "s".repeat(32),
        APP_ORIGIN: "https://sigae.example.invalid",
      },
      localAlertSignerSource: source,
      trustedSigningKeys: trustedKeys,
    });

    const dependencies = captures.calls[0]?.[2] as {
      alertSigningKeyProvider?: { getActiveSigner(): unknown };
    };
    expect(dependencies.alertSigningKeyProvider).toBeDefined();
    expect(source.getActiveSigner).not.toHaveBeenCalled();
    expect(trustedKeys.resolve).not.toHaveBeenCalled();
    expect(captures.listen).toHaveBeenCalledOnce();
  });

  it("rechaza una composición parcial de fuente y catálogo confiable", () => {
    const source: LocalAlertSignerSource = { getActiveSigner: vi.fn() };

    expect(() => startServer({ environment, localAlertSignerSource: source }))
      .toThrow("M3_SIGNING_SOURCE_CONFIGURATION_INCOMPLETE");
    expect(captures.calls).toHaveLength(0);
    expect(captures.listen).not.toHaveBeenCalled();
  });

  it("compone el firmador DPAPI solo con kid y política completos", () => {
    const trustedKeys: TrustedPublicKeyCatalog = { resolve: vi.fn(() => fakePublicKey()) };

    startServer({
      environment: {
        ...environment,
        SIGAE_M3_SIGNING_ENABLED: "true",
        SESSION_SECRET: "s".repeat(32),
        APP_ORIGIN: "https://sigae.example.invalid",
      },
      trustedSigningKeys: trustedKeys,
      dpapiSignerKid: "approved-test-kid",
      dpapiSignerPolicy: dpapiPolicy,
    });

    const dependencies = captures.calls[0]?.[2] as {
      alertSigningKeyProvider?: { getActiveSigner(): unknown };
    };
    expect(dependencies.alertSigningKeyProvider).toBeDefined();
    expect(trustedKeys.resolve).not.toHaveBeenCalled();
  });

  it("rechaza configuración DPAPI incompleta o ambigua antes de crear la aplicación", () => {
    expect(() => startServer({
      environment,
      dpapiSignerKid: "approved-test-kid",
    })).toThrow("M3_SIGNING_SOURCE_CONFIGURATION_INCOMPLETE");
    expect(() => startServer({
      environment,
      localAlertSignerSource: { getActiveSigner: vi.fn() },
      dpapiSignerKid: "approved-test-kid",
      dpapiSignerPolicy: dpapiPolicy,
    })).toThrow("M3_SIGNING_SOURCE_CONFIGURATION_AMBIGUOUS");
    expect(captures.calls).toHaveLength(0);
    expect(captures.listen).not.toHaveBeenCalled();
  });
});
