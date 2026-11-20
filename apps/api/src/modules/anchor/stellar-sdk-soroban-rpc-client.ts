import { AsyncLocalStorage } from "node:async_hooks";
import {
  Account,
  Contract,
  StrKey,
  type Transaction,
  TransactionBuilder,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import type { AnchorDeploymentConfig } from "./soroban-anchor-gateway.js";
import type { SorobanTestnetRpcClient } from "./soroban-testnet-anchor-gateway.js";
import { normalizeTrustedTestnetRpcUrl } from "./trusted-testnet-deployment.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const TRUSTED_TESTNET_RPC_URL = "https://soroban-testnet.stellar.org";
const CONTRACT_ID_PATTERN = /^C[A-Z2-7]{55}$/u;
const PUBLIC_ADDRESS_PATTERN = /^G[A-Z2-7]{55}$/u;
const HASH_PATTERN = /^[A-Fa-f0-9]{64}$/u;
const SDK_TIMEOUT_MESSAGE = /^timeout of \d+ms exceeded$/u;

type StellarRpcHttpClient = InstanceType<typeof rpc.Server>["httpClient"];
type StellarRpcCancelToken = InstanceType<StellarRpcHttpClient["CancelToken"]>;

export interface StellarRpcServer {
  getContractWasmByContractId?(contractId: string): Promise<Uint8Array>;
  getNetwork(): Promise<{ readonly passphrase: string }>;
  getTransaction(transactionHash: string): Promise<{
    readonly status: string;
    readonly txHash: string;
    readonly ledger?: number;
  }>;
  getAccount(address: string): Promise<Account>;
  simulateTransaction(transaction: Transaction): Promise<{
    readonly error?: string;
    readonly result?: { readonly retval: xdr.ScVal };
  }>;
  readonly httpClient?: StellarRpcHttpClient;
}

export interface StellarSdkSorobanRpcConfig {
  readonly endpointUrl: string;
  readonly deployment: AnchorDeploymentConfig;
  readonly timeoutMs: number;
}

export type StellarRpcServerFactory = (
  endpointUrl: string,
  timeoutMs: number,
) => StellarRpcServer;

function isValidDeployment(deployment: AnchorDeploymentConfig): boolean {
  if (deployment.network !== "TESTNET" ||
      deployment.networkPassphrase !== TESTNET_PASSPHRASE ||
      typeof deployment.id !== "string" || deployment.id.length === 0 ||
      !CONTRACT_ID_PATTERN.test(deployment.contractId) ||
      !HASH_PATTERN.test(deployment.wasmHash) ||
      !PUBLIC_ADDRESS_PATTERN.test(deployment.adminPublicAddress) ||
      !Number.isSafeInteger(deployment.generation) || deployment.generation < 1 ||
      typeof deployment.trustedConfigVersion !== "string" ||
      deployment.trustedConfigVersion.length === 0) {
    return false;
  }
  try {
    return StrKey.decodeContract(deployment.contractId).length === 32 &&
      StrKey.decodeEd25519PublicKey(deployment.adminPublicAddress).length === 32;
  } catch {
    return false;
  }
}

function assertBytesN32(value: Uint8Array, code: string): void {
  if (!(value instanceof Uint8Array) || value.length !== 32) {
    throw new TypeError(code);
  }
}

function assertEndpoint(endpointUrl: string, configuredEndpointUrl: string): void {
  let normalized: string;
  try {
    normalized = normalizeTrustedTestnetRpcUrl(endpointUrl);
  } catch {
    throw new Error("STELLAR_RPC_ENDPOINT_REJECTED");
  }
  if (normalized !== configuredEndpointUrl) {
    throw new Error("STELLAR_RPC_ENDPOINT_REJECTED");
  }
}

function throwSanitized(errorCode: string): never {
  throw new Error(errorCode);
}

function sanitizedRpcError(error: unknown, fallback: string, signal: AbortSignal): string {
  if (signal.aborted || (error instanceof Error && error.message === "STELLAR_RPC_ABORTED")) {
    return "STELLAR_RPC_ABORTED";
  }
  if (error instanceof Error &&
      (error.name === "TimeoutError" || SDK_TIMEOUT_MESSAGE.test(error.message))) {
    return "STELLAR_RPC_TIMEOUT";
  }
  return fallback;
}

export function encodeBytesN32(value: Uint8Array): xdr.ScVal {
  assertBytesN32(value, "STELLAR_BYTES_N32_INVALID");
  return xdr.ScVal.scvBytes(Uint8Array.from(value));
}

export function decodeOptionBytesN32(value: xdr.ScVal): Uint8Array | null {
  if (value.type === "scvVoid") return null;
  if (value.type !== "scvBytes") {
    throw new TypeError("STELLAR_OPTION_BYTES_N32_INVALID");
  }

  const bytes = value.value.toXdrObject();
  if (bytes.length !== 32) {
    throw new TypeError("STELLAR_OPTION_BYTES_N32_INVALID");
  }
  return Uint8Array.from(bytes);
}

export function buildRegisterAlertInvocation(
  deployment: AnchorDeploymentConfig,
  messageKey: Uint8Array,
  jwsHash: Uint8Array,
) {
  if (!isValidDeployment(deployment)) {
    throw new TypeError("STELLAR_DEPLOYMENT_REJECTED");
  }
  return new Contract(deployment.contractId).call(
    "register_alert",
    encodeBytesN32(messageKey),
    encodeBytesN32(jwsHash),
  );
}

function defaultServerFactory(endpointUrl: string, timeoutMs: number): StellarRpcServer {
  const server = new rpc.Server(endpointUrl, { allowHttp: false, timeout: timeoutMs });
  server.httpClient.defaults.maxRedirects = 0;
  return server;
}

export class StellarSdkSorobanRpcClient implements SorobanTestnetRpcClient {
  private readonly config: StellarSdkSorobanRpcConfig;
  private readonly serverFactory: StellarRpcServerFactory;
  private readonly requestContext = new AsyncLocalStorage<StellarRpcCancelToken>();
  private server: StellarRpcServer | undefined;

  constructor(
    config: StellarSdkSorobanRpcConfig,
    serverFactory: StellarRpcServerFactory = defaultServerFactory,
  ) {
    if (!isValidDeployment(config.deployment) ||
        normalizeTrustedTestnetRpcUrl(config.endpointUrl) !== TRUSTED_TESTNET_RPC_URL + "/" ||
        !Number.isSafeInteger(config.timeoutMs) ||
        config.timeoutMs < 1 ||
        config.timeoutMs > 120_000) {
      throw new TypeError("STELLAR_SDK_RPC_CONFIGURATION_INVALID");
    }
    this.config = Object.freeze({
      ...config,
      endpointUrl: normalizeTrustedTestnetRpcUrl(config.endpointUrl),
      deployment: Object.freeze({ ...config.deployment }),
    });
    this.serverFactory = serverFactory;
  }

  async getNetwork(input: {
    readonly endpointUrl: string;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    this.assertRequest(input.endpointUrl, input.signal);
    try {
      return await this.withRequestCancellation(input.signal, async (server) => {
        const response = await server.getNetwork();
        this.assertNotAborted(input.signal);
        if (typeof response.passphrase !== "string") throw new Error("invalid");
        return { passphrase: response.passphrase };
      });
    } catch (error) {
      return throwSanitized(sanitizedRpcError(
        error, "STELLAR_RPC_NETWORK_QUERY_FAILED", input.signal,
      ));
    }
  }

  async getContractWasm(input: {
    readonly endpointUrl: string;
    readonly contractId: string;
    readonly signal: AbortSignal;
  }): Promise<Uint8Array> {
    this.assertRequest(input.endpointUrl, input.signal);
    if (input.contractId !== this.config.deployment.contractId) {
      throw new Error("STELLAR_DEPLOYMENT_REJECTED");
    }
    try {
      return await this.withRequestCancellation(input.signal, async (server) => {
        const method = server.getContractWasmByContractId;
        if (!method) throw new Error("unsupported");
        const wasm = await method.call(server, input.contractId);
        this.assertNotAborted(input.signal);
        if (!(wasm instanceof Uint8Array) || wasm.length === 0) throw new Error("invalid");
        return Uint8Array.from(wasm);
      });
    } catch (error) {
      return throwSanitized(sanitizedRpcError(
        error, "STELLAR_RPC_WASM_QUERY_FAILED", input.signal,
      ));
    }
  }

  async getTransaction(input: {
    readonly endpointUrl: string;
    readonly transactionHash: string;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    this.assertRequest(input.endpointUrl, input.signal);
    if (!HASH_PATTERN.test(input.transactionHash)) {
      throw new TypeError("STELLAR_TRANSACTION_HASH_INVALID");
    }
    try {
      return await this.withRequestCancellation(input.signal, async (server) => {
        const response = await server.getTransaction(input.transactionHash);
        this.assertNotAborted(input.signal);
        if (response.txHash.toLowerCase() !== input.transactionHash.toLowerCase()) {
          return { status: "INVALID" };
        }
        if (response.status === rpc.Api.GetTransactionStatus.SUCCESS) {
          return { status: "SUCCESS", txHash: response.txHash, ledger: response.ledger };
        }
        if (response.status === rpc.Api.GetTransactionStatus.FAILED) {
          return { status: "FAILED", txHash: response.txHash };
        }
        if (response.status === rpc.Api.GetTransactionStatus.NOT_FOUND) {
          return { status: "NOT_FOUND", txHash: response.txHash };
        }
        return { status: "INVALID" };
      });
    } catch (error) {
      return throwSanitized(sanitizedRpcError(
        error, "STELLAR_RPC_TRANSACTION_QUERY_FAILED", input.signal,
      ));
    }
  }

  async getAlert(input: {
    readonly endpointUrl: string;
    readonly networkPassphrase: string;
    readonly contractId: string;
    readonly messageKey: Uint8Array;
    readonly signal: AbortSignal;
  }): Promise<unknown> {
    this.assertRequest(input.endpointUrl, input.signal);
    if (input.networkPassphrase !== TESTNET_PASSPHRASE ||
        input.networkPassphrase !== this.config.deployment.networkPassphrase ||
        input.contractId !== this.config.deployment.contractId ||
        !CONTRACT_ID_PATTERN.test(input.contractId)) {
      throw new Error("STELLAR_DEPLOYMENT_REJECTED");
    }
    assertBytesN32(input.messageKey, "STELLAR_MESSAGE_KEY_INVALID");

    try {
      return await this.withRequestCancellation(input.signal, async (server) => {
        const source = await server.getAccount(this.config.deployment.adminPublicAddress);
        this.assertNotAborted(input.signal);
        if (!(source instanceof Account) ||
            source.accountId() !== this.config.deployment.adminPublicAddress) {
          throw new Error("invalid");
        }
        const transaction = new TransactionBuilder(source, {
          fee: "100",
          networkPassphrase: TESTNET_PASSPHRASE,
        })
          .addOperation(new Contract(input.contractId).call(
            "get_alert",
            encodeBytesN32(input.messageKey),
          ))
          .setTimeout(Math.max(1, Math.ceil(this.config.timeoutMs / 1_000)))
          .build();
        const simulation = await server.simulateTransaction(transaction);
        this.assertNotAborted(input.signal);
        if ("error" in simulation || simulation.result === undefined) {
          throw new Error("invalid");
        }
        const value = decodeOptionBytesN32(simulation.result.retval);
        return {
          contractId: input.contractId,
          method: "get_alert",
          messageKey: Uint8Array.from(input.messageKey),
          value,
        };
      });
    } catch (error) {
      return throwSanitized(sanitizedRpcError(
        error, "STELLAR_RPC_CONTRACT_READ_FAILED", input.signal,
      ));
    }
  }

  private getServer(): StellarRpcServer {
    if (this.server === undefined) {
      this.server = this.serverFactory(this.config.endpointUrl, this.config.timeoutMs);
      const httpClient = this.server.httpClient;
      if (httpClient) {
        httpClient.interceptors.request.use((request) => {
          const cancelToken = this.requestContext.getStore();
          return cancelToken === undefined ? request : { ...request, cancelToken };
        });
      }
    }
    return this.server;
  }

  private async withRequestCancellation<T>(
    signal: AbortSignal,
    operation: (server: StellarRpcServer) => Promise<T>,
  ): Promise<T> {
    const server = this.getServer();
    const httpClient = server.httpClient;
    if (!httpClient) return operation(server);

    let cancelRequest: ((message?: string) => void) | undefined;
    const cancelToken = new httpClient.CancelToken((cancel) => { cancelRequest = cancel; });
    const abort = () => cancelRequest?.("Soroban RPC operation aborted");
    if (signal.aborted) {
      abort();
      throw new Error("STELLAR_RPC_ABORTED");
    }
    signal.addEventListener("abort", abort, { once: true });
    try {
      return await this.requestContext.run(cancelToken, () => operation(server));
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  private assertRequest(endpointUrl: string, signal: AbortSignal): void {
    assertEndpoint(endpointUrl, this.config.endpointUrl);
    this.assertNotAborted(signal);
  }

  private assertNotAborted(signal: AbortSignal): void {
    if (signal.aborted) throw new Error("STELLAR_RPC_ABORTED");
  }
}
