import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createConfiguredApp } from "./bootstrap.js";
import { M1LabDatabaseError } from "./config/m1-lab-database.js";
import { loadRootEnvironmentFile } from "./infrastructure/environment/load-root-env-file.js";
import { createPrismaClient } from "./infrastructure/database/prisma-client.js";
import type { TrustedPublicKeyCatalog } from "./modules/signing/trusted-public-keys.js";
import { TrustedAlertSigningKeyProvider } from "./modules/signing/trusted-alert-signing-key-provider.js";
import type { LocalAlertSignerSource } from "./modules/signing/local-alert-signer-source.js";
import {
  DpapiIpcAlertSignerSource,
  FramedDpapiSignerExchange,
} from "./modules/signing/dpapi-signer-ipc.js";
import {
  DotnetVerifierBridgeChannel,
  type TrustedDotnetVerifierPolicy,
} from "./modules/signing/dotnet-verifier-bridge-channel.js";
import { WindowsDpapiNamedPipeChannel } from "./modules/signing/windows-dpapi-pipe-channel.js";

export interface ServerDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly clientFactory?: typeof createPrismaClient;
  readonly localAlertSignerSource?: LocalAlertSignerSource;
  readonly trustedSigningKeys?: TrustedPublicKeyCatalog;
  readonly dpapiSignerKid?: string;
  readonly dpapiSignerPolicy?: TrustedDotnetVerifierPolicy;
}

export function startServer(dependencies: ServerDependencies = {}) {
  let source = dependencies.environment;
  if (!source) {
    if (process.env.SIGAE_M1_LAB === undefined && process.env.NODE_ENV !== "production") {
      loadRootEnvironmentFile();
      if (process.env.SIGAE_M1_LAB !== undefined) throw new M1LabDatabaseError();
    }
    source = process.env;
  }

  const hasInjectedSource = dependencies.localAlertSignerSource !== undefined;
  const hasDpapiConfiguration = dependencies.dpapiSignerKid !== undefined ||
    dependencies.dpapiSignerPolicy !== undefined;
  if (hasInjectedSource && hasDpapiConfiguration) {
    throw new Error("M3_SIGNING_SOURCE_CONFIGURATION_AMBIGUOUS");
  }
  if (hasDpapiConfiguration &&
      (dependencies.dpapiSignerKid === undefined || dependencies.dpapiSignerPolicy === undefined)) {
    throw new Error("M3_SIGNING_SOURCE_CONFIGURATION_INCOMPLETE");
  }
  const localAlertSignerSource = hasDpapiConfiguration
    ? dependencies.dpapiSignerKid !== undefined && dependencies.dpapiSignerPolicy !== undefined
      ? new DpapiIpcAlertSignerSource({
        kid: dependencies.dpapiSignerKid,
        exchange: new FramedDpapiSignerExchange(
          new WindowsDpapiNamedPipeChannel(
            new DotnetVerifierBridgeChannel(dependencies.dpapiSignerPolicy),
          ),
        ),
      })
      : undefined
    : dependencies.localAlertSignerSource;
  const trustedSigningKeys = dependencies.trustedSigningKeys;
  const hasKeySource = localAlertSignerSource !== undefined;
  const hasTrustedCatalog = trustedSigningKeys !== undefined;
  if (hasKeySource !== hasTrustedCatalog) {
    throw new Error("M3_SIGNING_SOURCE_CONFIGURATION_INCOMPLETE");
  }
  const alertSigningKeyProvider = localAlertSignerSource && trustedSigningKeys
    ? new TrustedAlertSigningKeyProvider(localAlertSignerSource, trustedSigningKeys)
    : undefined;

  const configured = createConfiguredApp(
    source,
    dependencies.clientFactory ?? createPrismaClient,
    alertSigningKeyProvider ? { alertSigningKeyProvider } : {},
  );
  if (configured.environment.isProduction && !existsSync(new URL("../../web/dist/index.html", import.meta.url))) {
    throw new Error("WEB_FRONTEND_BUILD_MISSING");
  }
  const server = configured.app.listen(configured.environment.port, configured.environment.host, () => {
    console.info(`SIGA-E API escuchando en ${configured.environment.host}:${configured.environment.port}`);
  });
  return { ...configured, server };
}

const entryPoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPoint === import.meta.url) startServer();
