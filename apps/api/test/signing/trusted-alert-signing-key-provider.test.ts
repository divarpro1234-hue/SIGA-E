import type { CryptoKey } from "jose";
import { describe, expect, it, vi } from "vitest";
import type { AlertSigner } from "../../src/modules/signing/alert-signer.js";
import type { TrustedPublicKeyCatalog } from "../../src/modules/signing/trusted-public-keys.js";
import { TrustedAlertSigningKeyProvider } from "../../src/modules/signing/trusted-alert-signing-key-provider.js";
import type { LocalAlertSignerSource } from "../../src/modules/signing/local-alert-signer-source.js";

function fakePublicKey(namedCurve = "P-256"): CryptoKey {
  return {
    type: "public",
    extractable: false,
    algorithm: { name: "ECDSA", namedCurve },
    usages: ["verify"],
  } as CryptoKey;
}

function fixture(options: {
  kid?: string;
  trustedKey?: CryptoKey;
  sourceFailure?: boolean;
  signerFailure?: boolean;
} = {}) {
  const kid = options.kid ?? "approved-test-kid";
  const signer: AlertSigner = {
    kid,
    sign: vi.fn(async () => {
      if (options.signerFailure) throw new Error("private-key-material-secret");
      return "synthetic.compact.jws";
    }),
  };
  const source: LocalAlertSignerSource = {
    getActiveSigner: vi.fn(() => {
      if (options.sourceFailure) throw new Error("private-key-material-secret");
      return signer;
    }),
  };
  const trustedPublicKeys: TrustedPublicKeyCatalog = {
    resolve: vi.fn((candidate) => candidate === "approved-test-kid"
      ? options.trustedKey ?? fakePublicKey()
      : undefined),
  };
  return { source, signer, trustedPublicKeys };
}

describe("TrustedAlertSigningKeyProvider", () => {
  it("entrega solo la operación de firma asociada al kid confiable", () => {
    const { source, signer, trustedPublicKeys } = fixture();
    const provider = new TrustedAlertSigningKeyProvider(source, trustedPublicKeys);

    const resolved = provider.getActiveSigner();

    expect(resolved.kid).toBe("approved-test-kid");
    expect(JSON.stringify(resolved)).toBe(JSON.stringify({ kid: "approved-test-kid" }));
    expect(Object.keys(resolved)).not.toContain("privateKey");
    expect(source.getActiveSigner).toHaveBeenCalledOnce();
    expect(trustedPublicKeys.resolve).toHaveBeenCalledExactlyOnceWith("approved-test-kid");
    expect(signer.sign).not.toHaveBeenCalled();
  });

  it("rechaza un kid desconocido antes de exponer el firmante", () => {
    const { source, trustedPublicKeys } = fixture({ kid: "untrusted-test-kid" });
    const provider = new TrustedAlertSigningKeyProvider(source, trustedPublicKeys);

    expect(() => provider.getActiveSigner()).toThrowError(
      expect.objectContaining({ code: "UNTRUSTED_KEY" }),
    );
    expect(trustedPublicKeys.resolve).toHaveBeenCalledExactlyOnceWith("untrusted-test-kid");
  });

  it("rechaza metadatos incompatibles en la clave pública confiable", () => {
    const { source, trustedPublicKeys } = fixture({ trustedKey: fakePublicKey("P-384") });
    const provider = new TrustedAlertSigningKeyProvider(source, trustedPublicKeys);

    expect(() => provider.getActiveSigner()).toThrowError(
      expect.objectContaining({ code: "INVALID_TRUSTED_KEY" }),
    );
  });

  it("sanitiza errores de inicialización y de operación de firma", async () => {
    const sourceFailure = fixture({ sourceFailure: true });
    expect(() => new TrustedAlertSigningKeyProvider(
      sourceFailure.source, sourceFailure.trustedPublicKeys,
    ).getActiveSigner()).toThrowError(
      expect.objectContaining({ code: "SIGNING_KEY_SOURCE_UNAVAILABLE" }),
    );

    const signerFailure = fixture({ signerFailure: true });
    const signer = new TrustedAlertSigningKeyProvider(
      signerFailure.source, signerFailure.trustedPublicKeys,
    ).getActiveSigner();
    try {
      await signer.sign(new Uint8Array([1]));
      throw new Error("expected sanitized signer failure");
    } catch (error) {
      expect(error).toMatchObject({ code: "SIGNATURE_OPERATION_FAILED" });
      expect(String(error)).not.toContain("private-key-material-secret");
    }
  });
});
