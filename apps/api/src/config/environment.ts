import { z } from "zod";
import {
  ANCHOR_OPERATOR_DATABASE,
  ANCHOR_OPERATOR_MIGRATOR_ROLE,
  ANCHOR_OPERATOR_RUNTIME_ROLE,
} from "./anchor-operator-database.js";
import { validateM1LabDatabase } from "./m1-lab-database.js";

const postgresUrlSchema = z.string().min(1).superRefine((value, context) => {
  try {
    const protocol = new URL(value).protocol;

    if (protocol !== "postgresql:" && protocol !== "postgres:") {
      context.addIssue({
        code: "custom",
        message: "debe usar el protocolo PostgreSQL",
      });
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "debe ser una URL PostgreSQL válida",
    });
  }
});

const environmentSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).optional(),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: postgresUrlSchema,
  SIGAE_M1_LAB: z.literal("true").optional(),
  SIGAE_M1_RENDER_ENABLED: z.literal("true").optional(),
  SESSION_SECRET: z.string().min(32).optional(),
  APP_ORIGIN: z.url().optional(),
  M1_WRITES_ENABLED: z.literal("true").optional(),
  SIGAE_M3_SIGNING_ENABLED: z.literal("true").optional(),
  TOTP_ENCRYPTION_KEY: z.string().min(32).optional(),
});

export interface Environment {
  readonly nodeEnv: "development" | "test" | "production";
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly m1Lab: boolean;
  readonly m1Render: boolean;
  readonly m2Diagnostics: boolean;
  readonly isProduction: boolean;
  readonly sessionSecret?: string;
  readonly appOrigin?: string;
  readonly m1WritesEnabled: boolean;
  readonly m3SigningEnabled: boolean;
  readonly totpEncryptionKey?: string;
}

export class EnvironmentConfigurationError extends Error {
  override readonly name = "EnvironmentConfigurationError";
}

export function loadEnvironment(source: NodeJS.ProcessEnv = process.env): Environment {
  const unsupportedSigningFields = ["JWS_PRIVATE_KEY_PATH", "JWS_KID"]
    .filter((field) => source[field] !== undefined);
  if (unsupportedSigningFields.length > 0) {
    throw new EnvironmentConfigurationError(
      `Configuración de firma no soportada en: ${unsupportedSigningFields.join(", ")}.`,
    );
  }
  // Una intención de laboratorio inválida debe fallar cerrada, sin volver al perfil normal.
  if (source.SIGAE_M1_LAB !== undefined && source.SIGAE_M1_LAB !== "true") {
    throw new EnvironmentConfigurationError("Configuración inválida en: SIGAE_M1_LAB.");
  }
  if (source.M1_WRITES_ENABLED === "true" &&
      source.SIGAE_M1_LAB !== "true" && source.SIGAE_M1_RENDER_ENABLED !== "true") {
    throw new EnvironmentConfigurationError(
        "M1_WRITES_ENABLED requiere SIGAE_M1_LAB=true o SIGAE_M1_RENDER_ENABLED=true.",
    );
  }
  if (source.SIGAE_M1_RENDER_ENABLED === "true" && source.NODE_ENV !== "production") {
    throw new EnvironmentConfigurationError("SIGAE_M1_RENDER_ENABLED requiere NODE_ENV=production.");
  }
  if (source.SIGAE_M1_RENDER_ENABLED === "true" && source.SIGAE_M1_LAB === "true") {
    throw new EnvironmentConfigurationError("Los perfiles M1 de laboratorio y despliegue no se pueden combinar.");
  }
  if (Object.keys(source).some((name) =>
    name.startsWith("SIGAE_M5_") || name.startsWith("STELLAR_") ||
    name.startsWith("SIGAE_M1_ADMIN_BOOTSTRAP_") || name === "SIGAE_M1_ALLOWED_OPERATOR")) {
    throw new EnvironmentConfigurationError(
      "Las variables de operador M5/M1-CLI y de Stellar no son válidas para el servidor HTTP.",
    );
  }
  if (source.SIGAE_M1_LAB === "true") validateM1LabDatabase(source);
  const result = environmentSchema.safeParse(source);

  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".")))]
      .filter((field) => field.length > 0)
      .sort();

    throw new EnvironmentConfigurationError(
      `Configuración inválida en: ${fields.join(", ") || "entorno"}.`,
    );
  }

  if (isAnchorOperatorDatabase(result.data.DATABASE_URL)) {
    throw new EnvironmentConfigurationError(
      "La base Anchor Operator no está autorizada para el servidor HTTP.",
    );
  }
  if (result.data.APP_ORIGIN && !isExactHttpsOrigin(result.data.APP_ORIGIN)) {
    throw new EnvironmentConfigurationError(
      "APP_ORIGIN debe ser un origen HTTPS exacto, sin ruta ni barra final.",
    );
  }
  const host = result.data.HOST ?? (result.data.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
  if (result.data.SIGAE_M1_LAB === "true" && host !== "127.0.0.1") {
    throw new EnvironmentConfigurationError("El laboratorio M1 solo puede enlazarse a 127.0.0.1.");
  }
  if (result.data.NODE_ENV === "production" && host !== "0.0.0.0") {
    throw new EnvironmentConfigurationError("El servidor de Render debe enlazarse a 0.0.0.0.");
  }
  if (result.data.NODE_ENV === "production" &&
      new URL(result.data.DATABASE_URL).searchParams.get("sslmode") !== "require") {
    throw new EnvironmentConfigurationError("DATABASE_URL de producción debe exigir TLS PostgreSQL (sslmode=require).");
  }
  if (result.data.NODE_ENV === "production") {
    const database = new URL(result.data.DATABASE_URL);
    if (!database.username || !database.password) {
      throw new EnvironmentConfigurationError("DATABASE_URL de producción requiere credenciales PostgreSQL.");
    }
    if (!isCanonicalSecret(result.data.SESSION_SECRET)) {
      throw new EnvironmentConfigurationError("SESSION_SECRET de producción debe contener al menos 32 bytes Base64URL canónicos.");
    }
  }
  if (result.data.NODE_ENV === "production" &&
      (result.data.SIGAE_M1_RENDER_ENABLED !== "true" || result.data.M1_WRITES_ENABLED !== "true")) {
    throw new EnvironmentConfigurationError("Producción requiere el perfil M1 explícito y sus escrituras habilitadas.");
  }
  if (result.data.NODE_ENV === "production" && result.data.SIGAE_M3_SIGNING_ENABLED === "true") {
    throw new EnvironmentConfigurationError("M3 está fuera del alcance del despliegue académico.");
  }
  if (result.data.M1_WRITES_ENABLED === "true" &&
      (!result.data.SESSION_SECRET ||
       !result.data.APP_ORIGIN ||
       !isCanonicalTotpKey(result.data.TOTP_ENCRYPTION_KEY))) {
    throw new EnvironmentConfigurationError(
      "El perfil HTTP M1 requiere SESSION_SECRET, APP_ORIGIN HTTPS y TOTP_ENCRYPTION_KEY válida.",
    );
  }

  return Object.freeze({
    nodeEnv: result.data.NODE_ENV,
    host,
    port: result.data.PORT,
    databaseUrl: result.data.DATABASE_URL,
    m1Lab: result.data.SIGAE_M1_LAB === "true",
    m1Render: result.data.SIGAE_M1_RENDER_ENABLED === "true",
    m2Diagnostics: source.SIGAE_M2_DIAGNOSTICS === "true" && result.data.SIGAE_M1_LAB === "true",
    isProduction: result.data.NODE_ENV === "production",
    ...(result.data.SESSION_SECRET ? { sessionSecret: result.data.SESSION_SECRET } : {}),
    ...(result.data.APP_ORIGIN ? { appOrigin: result.data.APP_ORIGIN } : {}),
    m1WritesEnabled: result.data.M1_WRITES_ENABLED === "true",
    m3SigningEnabled: result.data.SIGAE_M3_SIGNING_ENABLED === "true",
    ...(result.data.TOTP_ENCRYPTION_KEY ? { totpEncryptionKey: result.data.TOTP_ENCRYPTION_KEY } : {}),
  });
}

function isExactHttpsOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}

function isCanonicalTotpKey(value: string | undefined): boolean {
  if (!value || value.length !== 43) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 && decoded.toString("base64url") === value;
}

function isCanonicalSecret(value: string | undefined): boolean {
  if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length >= 32 && decoded.toString("base64url") === value;
}

function isAnchorOperatorDatabase(value: string): boolean {
  try {
    return decodeURIComponent(new URL(value).pathname.slice(1)) === ANCHOR_OPERATOR_DATABASE;
  } catch {
    return false;
  }
}
