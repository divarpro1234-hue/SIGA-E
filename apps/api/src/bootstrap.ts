import { fileURLToPath } from "node:url";

import { createApp } from "./app.js";
import { loadEnvironment } from "./config/environment.js";
import { createPrismaClient } from "./infrastructure/database/prisma-client.js";
import { PrismaSessionReader } from "./modules/identity/prisma-session-reader.js";
import { PrismaPendingUserService } from "./modules/identity/create-pending-user.js";
import { PrismaLoginService } from "./modules/identity/login-service.js";
import { PrismaTotpReconfigurationService } from "./modules/identity/totp-reconfiguration.js";
import { PrismaDraftAlertService } from "./modules/alerts/alert-draft-service.js";
import { PrismaPublicAlertService } from "./modules/public/public-alert-service.js";
import type { AlertSigningKeyProvider } from "./modules/signing/alert-signing-key-provider.js";
import type { AlertDiagnosticReporter } from "./presentation/http/diagnostic-reporting.js";

const simulatedAlertSender = "urn:siga-e:simulacro";

export interface ConfiguredAppDependencies {
  readonly alertSigningKeyProvider?: AlertSigningKeyProvider;
}

function isAlertSigningKeyProvider(value: unknown): value is AlertSigningKeyProvider {
  return value !== null && typeof value === "object" &&
    "getActiveSigner" in value && typeof value.getActiveSigner === "function" &&
    "getTrustedPublicKey" in value && typeof value.getTrustedPublicKey === "function";
}

export function createConfiguredApp(
  source: NodeJS.ProcessEnv = process.env,
  clientFactory: typeof createPrismaClient = createPrismaClient,
  dependencies: ConfiguredAppDependencies = {},
) {
  const environment = loadEnvironment(source);
  const webDistDirectory = environment.isProduction
    ? fileURLToPath(new URL("../../web/dist/", import.meta.url))
    : undefined;
  const signingProvider = dependencies.alertSigningKeyProvider;
  if (environment.m3SigningEnabled) {
    if (!isAlertSigningKeyProvider(signingProvider) ||
        !environment.appOrigin || !environment.sessionSecret) {
      throw new Error("M3_SIGNING_CONFIGURATION_INCOMPLETE");
    }
  } else if (signingProvider !== undefined) {
    throw new Error("M3_SIGNING_REQUIRES_EXPLICIT_ENABLEMENT");
  }

  const prisma = clientFactory(environment.databaseUrl);
  const databaseHost = new URL(environment.databaseUrl).hostname.toLowerCase();
  const localDatabase = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(databaseHost);
  const m1WritesEnabled = environment.m1WritesEnabled &&
    ((environment.m1Lab && localDatabase) || environment.m1Render);
  const totpKey = environment.totpEncryptionKey ? Buffer.from(environment.totpEncryptionKey, "base64url") : null;
  const loginService = m1WritesEnabled && environment.sessionSecret &&
    environment.appOrigin && totpKey?.length === 32
    ? new PrismaLoginService(prisma, totpKey, new TextEncoder().encode(environment.sessionSecret)) : undefined;
  const totpReconfigurationService = m1WritesEnabled && environment.sessionSecret &&
    environment.appOrigin && totpKey?.length === 32
    ? new PrismaTotpReconfigurationService(prisma, totpKey, new TextEncoder().encode(environment.sessionSecret)) : undefined;
  const reportDiagnostic: AlertDiagnosticReporter | undefined = environment.m2Diagnostics
    ? (event) => console.error({ requestId: event.requestId, stage: event.stage, code: event.code })
    : undefined;
  const app = createApp({
    production: environment.isProduction,
    ...(webDistDirectory ? { webDistDirectory } : {}),
    sessionReader: new PrismaSessionReader(prisma),
    publicAlertService: new PrismaPublicAlertService(prisma),
    ...(environment.sessionSecret ? { csrfSecret: new TextEncoder().encode(environment.sessionSecret) } : {}),
    ...(m1WritesEnabled && environment.appOrigin ? {
      appOrigin: environment.appOrigin, pendingUserService: new PrismaPendingUserService(prisma),
    } : {}),
    ...(loginService ? { loginService } : {}),
    ...(totpReconfigurationService ? { totpReconfigurationService } : {}),
    ...(environment.appOrigin && environment.sessionSecret ? {
      alertDraftService: new PrismaDraftAlertService(
        prisma, simulatedAlertSender, undefined, undefined, reportDiagnostic,
        environment.m3SigningEnabled ? signingProvider : undefined,
      ),
      appOrigin: environment.appOrigin,
    } : {}),
    reportError: ({ requestId, errorName, prismaCode, sqlState }) =>
      console.error({
        requestId,
        errorName,
        ...(prismaCode ? { prismaCode } : {}),
        ...(sqlState ? { sqlState } : {}),
      }),
    ...(reportDiagnostic ? { alertDiagnosticReporter: reportDiagnostic } : {}),
  });
  return { app, environment };
}
