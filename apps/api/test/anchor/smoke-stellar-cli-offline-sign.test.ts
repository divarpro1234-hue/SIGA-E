import { Account, Contract, Keypair, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildExpiredSyntheticTransaction, inspectExpiredSyntheticTransaction, main,
} from "../../scripts/smoke-stellar-cli-offline-sign.js";
import type { StellarCliProcessRunner } from "../../src/modules/anchor/stellar-cli-secure-store-signer.js";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";

const TEST_KEY = new Uint8Array(32).fill(0x11);
const TEST_HASH = new Uint8Array(32).fill(0x22);

function synthetic() {
  let call = 0;
  return buildExpiredSyntheticTransaction(() =>
    Uint8Array.from(++call === 1 ? TEST_KEY : TEST_HASH));
}

function mockSignedXdr(preparedXdr: string): string {
  const tx = new Transaction(preparedXdr, TRUSTED_TESTNET.networkPassphrase);
  const envelope = tx.toEnvelope();
  if (envelope.type !== "envelopeTypeTx") throw new Error();
  return xdr.TransactionEnvelope.envelopeTypeTx(new xdr.TransactionV1Envelope({
    tx: envelope.value.tx,
    signatures: [new xdr.DecoratedSignature({
      hint: Keypair.fromPublicKey(TRUSTED_TESTNET.adminPublicAddress).signatureHint(),
      signature: new Uint8Array(64).fill(0x55),
    })],
  })).toXdr("base64");
}

function harness() {
  const runner: StellarCliProcessRunner = {
    run: vi.fn(async (input) => ({
      exitCode: 0,
      stdout: mockSignedXdr(input.stdin.replace(/\r?\n$/u, "")) + "\n",
    })),
  };
  const output = vi.fn();
  let call = 0;
  const randomBytes = vi.fn(() => Uint8Array.from(++call === 1 ? TEST_KEY : TEST_HASH));
  return { runner, output, randomBytes };
}

beforeEach(() => vi.spyOn(Keypair.prototype, "verify").mockReturnValue(true));
afterEach(() => vi.restoreAllMocks());

describe("smoke offline de firma Stellar CLI", () => {
  it("construye XDR Testnet con secuencia sintética y límites ya caducados", () => {
    const built = synthetic();
    const parsed = inspectExpiredSyntheticTransaction(built);
    expect(parsed.networkPassphrase).toBe(TRUSTED_TESTNET.networkPassphrase);
    expect(parsed.source).toBe(TRUSTED_TESTNET.adminPublicAddress);
    expect(parsed.sequence).toBe("424242424243");
    expect(parsed.timeBounds).toEqual({ minTime: "1", maxTime: "2" });
    expect(Number(parsed.timeBounds!.maxTime) * 1_000).toBeLessThan(Date.now());
    expect(parsed.operations).toHaveLength(1);
    expect(parsed.operations[0]?.type).toBe("invokeHostFunction");
    expect(Buffer.from(built.messageKey).toString("hex"))
      .not.toBe("3d291345eaa3a7c2a086fccbf1993bd028afc9f67198bef931bda15210f9d6a0");
    expect(Buffer.from(built.jwsHash).toString("hex"))
      .not.toBe("5277fd15c7e222efe3d2931b53010e6a1ec9da1e53b7322db9c6f5685752db97");
  });

  it("rechaza límites temporales distintos al leer XDR", () => {
    const built = synthetic();
    const current = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "424242424242"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(TRUSTED_TESTNET.contractId).call("register_alert",
      xdr.ScVal.scvBytes(built.messageKey), xdr.ScVal.scvBytes(built.jwsHash)))
      .setTimebounds(0, Math.floor(Date.now() / 1_000) + 60).build();
    expect(() => inspectExpiredSyntheticTransaction({ ...built, transaction: current }))
      .toThrow("OFFLINE_XDR_NOT_EXPIRED_OR_UNTRUSTED");
  });

  it("rechaza argumentos y contrato distintos antes de solicitar aprobación", () => {
    const built = synthetic();
    expect(() => inspectExpiredSyntheticTransaction({
      ...built, messageKey: new Uint8Array(32).fill(9),
    })).toThrow("OFFLINE_XDR_ARGUMENT_MISMATCH");
    const otherContract = StrKey.encodeContract(new Uint8Array(32).fill(9));
    const altered = new TransactionBuilder(new Account(TRUSTED_TESTNET.adminPublicAddress, "424242424242"), {
      fee: "100", networkPassphrase: TRUSTED_TESTNET.networkPassphrase,
    }).addOperation(new Contract(otherContract).call("register_alert",
      xdr.ScVal.scvBytes(built.messageKey), xdr.ScVal.scvBytes(built.jwsHash)))
      .setTimebounds(1, 2).build();
    expect(() => inspectExpiredSyntheticTransaction({ ...built, transaction: altered })).toThrow();
  });

  it("sin opción no crea proceso ni solicita aprobación", async () => {
    const { runner, output, randomBytes } = harness();
    const approve = vi.fn(async () => true);
    await expect(main([], { runner, output, random: randomBytes, approve })).resolves.toBe(0);
    expect(runner.run).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    expect(randomBytes).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("Modo seguro"));
  });

  it("la opción de línea de comandos sola no autoriza la firma", async () => {
    const { runner, output, randomBytes } = harness();
    const approve = vi.fn(async () => false);
    await expect(main(["--sign-expired-offline"], {
      runner, output, random: randomBytes, approve,
    })).resolves.toBe(3);
    expect(approve).toHaveBeenCalledWith(expect.objectContaining({
      maxTime: "2", publicAddress: TRUSTED_TESTNET.adminPublicAddress,
    }));
    expect(runner.run).not.toHaveBeenCalled();
  });

  it("acepta firma simulada solo tras aprobación y nunca envía", async () => {
    const { runner, output, randomBytes } = harness();
    await expect(main(["--sign-expired-offline"], {
      runner, output, random: randomBytes, approve: vi.fn(async () => true),
    })).resolves.toBe(0);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(vi.mocked(runner.run).mock.calls[0]![0].args)
      .toEqual(["tx", "sign", "--network", "testnet", "--sign-with-key", "siga-e-testnet-admin"]);
    expect("sendTransaction" in runner).toBe(false);
    expect(output).toHaveBeenCalledWith(expect.stringContaining("No se envió"));
    const visible = output.mock.calls.map(([line]) => String(line)).join("\n");
    expect(visible).not.toContain("AAAAAg");
  });

  it("rechaza firma simulada inválida sin imprimir XDR", async () => {
    vi.spyOn(Keypair.prototype, "verify").mockReturnValue(false);
    const { runner, output, randomBytes } = harness();
    await expect(main(["--sign-expired-offline"], {
      runner, output, random: randomBytes, approve: vi.fn(async () => true),
    })).resolves.toBe(1);
    expect(runner.run).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith(expect.stringContaining("fallida"));
  });
});
