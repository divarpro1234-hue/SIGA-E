import { StrKey, xdr } from "@stellar/stellar-sdk";
import { TRUSTED_TESTNET } from "../../src/modules/anchor/trusted-testnet-deployment.js";

export function registerAlertAuthorization(input: {
  readonly contractId?: string;
  readonly messageKey: Uint8Array;
  readonly jwsHash: Uint8Array;
  readonly credentials?: xdr.SorobanCredentials;
  readonly functionName?: string;
  readonly subInvocations?: xdr.SorobanAuthorizedInvocation[];
}): xdr.SorobanAuthorizationEntry {
  const contractId = input.contractId ?? TRUSTED_TESTNET.contractId;
  const rootInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: xdr.ScAddress.scAddressTypeContract(
          xdr.ContractId.fromXdrObject(StrKey.decodeContract(contractId)),
        ),
        functionName: input.functionName ?? "register_alert",
        args: [
          xdr.ScVal.scvBytes(input.messageKey),
          xdr.ScVal.scvBytes(input.jwsHash),
        ],
      }),
    ),
    subInvocations: input.subInvocations ?? [],
  });
  return new xdr.SorobanAuthorizationEntry({
    credentials: input.credentials ?? xdr.SorobanCredentials.sorobanCredentialsSourceAccount(),
    rootInvocation,
  });
}

export function addressAuthorization(
  variant: "address" | "addressV2" | "addressWithDelegates",
  publicKeyBytes = new Uint8Array(32).fill(0x44),
  messageKey = new Uint8Array(32).fill(1),
  jwsHash = new Uint8Array(32).fill(2),
): xdr.SorobanAuthorizationEntry {
  const addressCredentials = new xdr.SorobanAddressCredentials({
    address: xdr.ScAddress.scAddressTypeAccount(
      xdr.PublicKey.publicKeyTypeEd25519(publicKeyBytes),
    ),
    nonce: 1n,
    signatureExpirationLedger: 100,
    signature: xdr.ScVal.scvVoid(),
  });
  const credentials = variant === "address"
    ? xdr.SorobanCredentials.sorobanCredentialsAddress(addressCredentials)
    : variant === "addressV2"
      ? xdr.SorobanCredentials.sorobanCredentialsAddressV2(addressCredentials)
      : xdr.SorobanCredentials.sorobanCredentialsAddressWithDelegates(
        new xdr.SorobanAddressCredentialsWithDelegates({
          addressCredentials,
          delegates: [],
        }),
      );
  return registerAlertAuthorization({ messageKey, jwsHash, credentials });
}
