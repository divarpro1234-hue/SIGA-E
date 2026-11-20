import {
  ANCHOR_OPERATOR_MIGRATOR_ROLE,
  ANCHOR_OPERATOR_RUNTIME_ROLE,
  validateAnchorOperatorM1Environment,
} from "./anchor-operator-database.js";

export const M1_LAB_PROFILE = "true";

export class M1LabDatabaseError extends Error {
  override readonly name = "M1LabDatabaseError";
  constructor() {
    super("Configuración PostgreSQL del laboratorio M1 inválida.");
  }
}

export function rejectM1LabForOtherPrismaConfig(): void {
  if (process.env.SIGAE_M1_LAB !== undefined) throw new M1LabDatabaseError();
}

const conflictingVariables = ["SIGAE_TEST_DIRECT_URL", "SIGAE_DEVELOPMENT_DIRECT_URL"];

export function validateM1LabDatabase(source: NodeJS.ProcessEnv): string {
  if (source["SIGAE_M5_ANCHOR_OPERATOR_LAB"] !== undefined) {
    try {
      return validateAnchorOperatorM1Environment(source);
    } catch {
      throw new M1LabDatabaseError();
    }
  }
  if (source.SIGAE_M1_LAB !== M1_LAB_PROFILE ||
      conflictingVariables.some((name) => source[name] !== undefined) ||
      Object.keys(source).some((name) => name.startsWith("SIGAE_M5_")) ||
      Object.keys(source).some((name) => name.startsWith("PG") || name.startsWith("NEON_"))) {
    throw new M1LabDatabaseError();
  }

  const databaseUrl = source.DATABASE_URL;
  const directUrl = source.DIRECT_URL;
  if (!databaseUrl || !directUrl || databaseUrl !== directUrl || !isExactLocalUrl(databaseUrl)) {
    throw new M1LabDatabaseError();
  }
  return databaseUrl;
}

function isExactLocalUrl(value: string): boolean {
  // Exigir autoridad, credenciales, host, puerto y nombre de BD literales.
  // No se admiten query, fragment, escapes en el destino ni normalizaciones del parser.
  const match = /^(postgresql|postgres):\/\/([^/?#]+)\/(sigae_m1_test|sigae_local_demo)$/.exec(value);
  if (!match) return false;
  const authority = match[2]!;
  const databaseName = match[3];
  const port = databaseName === "sigae_local_demo" ? "55433" : "55432";
  const credentials = new RegExp(`^([^:@]+):([^@]+)@127\\.0\\.0\\.1:${port}$`).exec(authority);
  if (!credentials || /%(?![\da-fA-F]{2})/.test(authority) || /[\u0000-\u0020\\]/.test(value)) return false;
  let username: string;
  try {
    username = decodeURIComponent(credentials[1]!);
  } catch {
    return false;
  }
  if ([ANCHOR_OPERATOR_RUNTIME_ROLE, ANCHOR_OPERATOR_MIGRATOR_ROLE].includes(username)) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === `${match[1]}:` && parsed.hostname === "127.0.0.1" &&
      parsed.port === port && parsed.pathname === `/${databaseName}` &&
      parsed.username.length > 0 && parsed.password.length > 0 &&
      parsed.search === "" && parsed.hash === "";
  } catch {
    return false;
  }
}
