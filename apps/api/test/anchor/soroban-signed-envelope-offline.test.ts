import { Account, Contract, Keypair, Operation, StrKey, Transaction, TransactionBuilder, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  assertTransactionTimeboundsCurrent, verifySignedEnvelope,
} from "../../src/modules/anchor/stellar-sdk-admin-submitter.js";
import { registerAlertAuthorization } from "./soroban-auth-fixtures.js";

const testnet = "Test SDF Network ; September 2015";
const publicNetwork = "Public Global Stellar Network ; September 2015";
const contractId = StrKey.encodeContract(new Uint8Array(32).fill(0x19));

function prepared(keypair: Keypair, sequence = "1", timeout = 30): Transaction {
  return new TransactionBuilder(new Account(keypair.publicKey(), sequence), {
    fee: "100", networkPassphrase: testnet,
  }).addOperation(new Contract(contractId).call("register_alert",
    xdr.ScVal.scvBytes(new Uint8Array(32).fill(1)),
    xdr.ScVal.scvBytes(new Uint8Array(32).fill(2)))).setTimeout(timeout).build();
}

function sign(unsigned: Transaction, keypair: Keypair, passphrase = testnet): string {
  const transaction = new Transaction(unsigned.toXdr(), passphrase);
  transaction.sign(keypair);
  return transaction.toXdr();
}

describe("sobre Soroban Ed25519 con cuentas efímeras en memoria", () => {
  it("acepta la firma real del hash exacto y la red Testnet", () => {
    const keypair = Keypair.random();
    const unsigned = prepared(keypair);
    const signed = verifySignedEnvelope(unsigned, sign(unsigned, keypair), keypair.publicKey(), testnet);
    expect(signed.toEnvelope().type).toBe("envelopeTypeTx");
    expect(signed.toXdr()).toBe(sign(unsigned, keypair));
    expect(signed.hash()).toEqual(unsigned.hash());
  });

  it("rechaza firma de otra red o cuenta y cambios del XDR aprobado", () => {
    const keypair = Keypair.random();
    const other = Keypair.random();
    const unsigned = prepared(keypair);
    expect(() => verifySignedEnvelope(unsigned, sign(unsigned, keypair, publicNetwork),
      keypair.publicKey(), testnet)).toThrow("SIGNATURE_REJECTED");
    expect(() => verifySignedEnvelope(unsigned, sign(unsigned, other),
      keypair.publicKey(), testnet)).toThrow("SIGNATURE_REJECTED");
    expect(() => verifySignedEnvelope(unsigned, sign(prepared(keypair, "2"), keypair),
      keypair.publicKey(), testnet)).toThrow("SIGNATURE_REJECTED");
    expect(() => verifySignedEnvelope(unsigned, `${sign(unsigned, keypair)}\n`,
      keypair.publicKey(), testnet)).toThrow("SIGNATURE_REJECTED");
    const operation = unsigned.operations[0];
    if (operation?.type !== "invokeHostFunction") throw new Error();
    const changedAuth = TransactionBuilder.cloneFrom(unsigned).clearOperations()
      .addOperation(Operation.invokeHostFunction({ func: operation.func,
        auth: [registerAlertAuthorization({ messageKey: new Uint8Array(32).fill(1),
          jwsHash: new Uint8Array(32).fill(2) })] })).build();
    expect(() => verifySignedEnvelope(unsigned, sign(changedAuth, keypair),
      keypair.publicKey(), testnet)).toThrow("SIGNATURE_REJECTED");
  });

  it("bloquea timebounds vencidos o aún no vigentes antes de cualquier transporte", () => {
    const keypair = Keypair.random();
    const unsigned = prepared(keypair);
    const bounds = unsigned.timeBounds!;
    const minTime = Number(bounds.minTime) * 1_000;
    const maxTime = Number(bounds.maxTime) * 1_000;
    expect(() => assertTransactionTimeboundsCurrent(unsigned, minTime)).not.toThrow();
    expect(() => assertTransactionTimeboundsCurrent(unsigned, maxTime))
      .toThrow("TRANSACTION_TIMEBOUNDS_EXPIRED");
    expect(() => assertTransactionTimeboundsCurrent(unsigned, minTime - 1_000))
      .toThrow("TRANSACTION_TIMEBOUNDS_EXPIRED");
    expect(() => assertTransactionTimeboundsCurrent(unsigned, maxTime - 20_000, 20)).not.toThrow();
    expect(() => assertTransactionTimeboundsCurrent(unsigned, maxTime - 19_999, 20))
      .toThrow("TRANSACTION_TIME_MARGIN_INSUFFICIENT");
  });
});
