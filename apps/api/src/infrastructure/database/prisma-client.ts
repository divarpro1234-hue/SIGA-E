import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../../generated/prisma/client.js";

export function createPrismaClient(databaseUrl: string): PrismaClient {
  // Diagnóstico M1: en America/La_Paz, PrismaPg 7.10.0 desplaza Date
  // +14400 s al enviar y -14400 s al recibir TIMESTAMPTZ.
  // UTC debe fijarse en el startup de cada conexión de pg.
  let connectionUrl: URL;
  try {
    connectionUrl = new URL(databaseUrl);
    if (connectionUrl.protocol !== "postgresql:" && connectionUrl.protocol !== "postgres:") {
      throw new TypeError("DATABASE_URL_INVALID");
    }
  } catch {
    throw new TypeError("DATABASE_URL_INVALID");
  }
  const existingOptions = connectionUrl.searchParams.getAll("options").filter(Boolean);
  connectionUrl.searchParams.delete("options");
  connectionUrl.searchParams.set("options", [...existingOptions, "-c TimeZone=UTC"].join(" "));
  const adapter = new PrismaPg({ connectionString: connectionUrl.toString() });

  return new PrismaClient({ adapter });
}
