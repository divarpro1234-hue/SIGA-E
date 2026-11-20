import { userInfo } from "node:os";
import { stdin, stdout } from "node:process";

import { assertM1ProductionAdminBootstrapTarget, M1ProductionAdminBootstrapError,
  readM1ProductionAdminBootstrapConfig, validateM1ProductionAdminBootstrapProfile } from "../src/config/m1-production-admin-bootstrap.js";
import { createPrismaClient } from "../src/infrastructure/database/prisma-client.js";
import { LabInputError, createLabPrompt, promptNewPassword } from "./m1-lab-input.js";
import { LabProvisioningError, LabProvisioningService } from "../src/modules/identity/lab-provisioning.js";

const activationVariables = [
  "SIGAE_M1_ADMIN_BOOTSTRAP_ENABLED",
  "SIGAE_M1_ADMIN_BOOTSTRAP_EXPIRES_AT",
  "SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_HOST",
  "SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_NAME",
  "SIGAE_M1_ADMIN_BOOTSTRAP_DATABASE_USER",
  "SIGAE_M1_ADMIN_BOOTSTRAP_TARGET_ID",
  "SIGAE_M1_ALLOWED_OPERATOR",
  "DATABASE_URL",
  "TOTP_ENCRYPTION_KEY",
] as const;

function preflight() {
  if (process.argv.length !== 3 || process.argv[2] !== "initialize-admin" ||
      process.env["CI"] || process.env["GITHUB_ACTIONS"] || process.env["TF_BUILD"] ||
      !stdin.isTTY || !stdout.isTTY || !stdin.setRawMode ||
      !process.env["SIGAE_M1_ALLOWED_OPERATOR"] ||
      userInfo().username !== process.env["SIGAE_M1_ALLOWED_OPERATOR"] ||
      process.env["SIGAE_M1_LAB"] !== undefined ||
      Object.keys(process.env).some((name) =>
        name.startsWith("SIGAE_M5_") || name.startsWith("STELLAR_"))) {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_OPERATOR_REJECTED");
  }
  const config = readM1ProductionAdminBootstrapConfig(process.env);
  return { config, prompt: createLabPrompt(stdin, stdout) };
}

function assertWindowOpen(expiresAt: Date): void {
  if (Date.now() >= expiresAt.getTime()) {
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_WINDOW_EXPIRED");
  }
}

async function main(): Promise<void> {
  let prisma: ReturnType<typeof createPrismaClient> | undefined;
  let password = "";
  let totpCode = "";
  try {
    const { config, prompt } = preflight();
    await assertM1ProductionAdminBootstrapTarget(config);
    const targetConfirmation = await prompt(
      `Verifique fuera de banda el host y marker. Escriba el nombre exacto de la base ${config.databaseName}: `,
    );
    if (targetConfirmation !== config.databaseName) {
      throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_TARGET_CONFIRMATION_FAILED");
    }

    const approvalReference = await prompt("Referencia de autorización humana registrada fuera del sistema: ");
    const name = await prompt("Nombre ficticio del ADMIN inicial: ");
    const email = await prompt("Correo ficticio del ADMIN inicial: ");
    password = await promptNewPassword(prompt);
    assertWindowOpen(config.expiresAt);

    prisma = createPrismaClient(config.databaseUrl);
    const service = new LabProvisioningService(
      prisma,
      config.totpKey,
      process.env,
      validateM1ProductionAdminBootstrapProfile,
    );
    const enrollment = await service.bootstrap(
      { name, email, role: "ADMIN", password },
      approvalReference,
    );

    stdout.write("\nEscanee este URI TOTP directamente en una aplicación autenticadora. No lo copie a archivos, capturas ni logs:\n");
    stdout.write(`${enrollment.otpauthUri}\n`);
    stdout.write("El ADMIN sigue PENDING_ENROLLMENT hasta confirmar el código TOTP.\n");

    for (let attempt = 1; attempt <= 5; attempt++) {
      assertWindowOpen(config.expiresAt);
      totpCode = await prompt("Código TOTP de seis dígitos: ", true);
      const activated = await service.confirm(
        email,
        totpCode,
        enrollment.invitationToken,
        enrollment.enrollmentToken,
      );
      totpCode = "";
      if (activated) {
        stdout.write("PASS: ADMIN inicial activado tras confirmar TOTP; no se creó sesión. El bootstrap queda consumido.\n");
        return;
      }
      if (attempt < 5) stdout.write(`Código rechazado. Intentos restantes: ${5 - attempt}.\n`);
    }
    throw new M1ProductionAdminBootstrapError("M1_PRODUCTION_BOOTSTRAP_TOTP_REJECTED");
  } catch (error) {
    const code = error instanceof M1ProductionAdminBootstrapError ||
      error instanceof LabProvisioningError || error instanceof LabInputError
      ? error.code
      : "M1_PRODUCTION_BOOTSTRAP_FAILED";
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  } finally {
    password = "";
    totpCode = "";
    if (prisma) await prisma.$disconnect();
    for (const variable of activationVariables) delete process.env[variable];
  }
}

void main();
