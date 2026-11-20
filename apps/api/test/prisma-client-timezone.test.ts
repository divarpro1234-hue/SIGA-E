import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";
import pg from "pg";

const state = vi.hoisted(() => ({
  adapterConfigs: [] as Array<{ connectionString: string }>,
  disconnect: vi.fn(async () => {}),
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(config: { connectionString: string }) {
      state.adapterConfigs.push(config);
    }
  },
}));
vi.mock("../src/generated/prisma/client.js", () => ({
  PrismaClient: class {
    $disconnect = state.disconnect;
  },
}));

import { createPrismaClient } from "../src/infrastructure/database/prisma-client.js";

const apiRoot = fileURLToPath(new URL("../", import.meta.url));
const url = "postgresql://ficticio:fixture-password@127.0.0.1:55432/sigae_m1_test";

describe("PrismaPg en UTC desde el inicio de la conexión", () => {
  it("añade UTC y conserva credenciales, destino y opciones existentes", async () => {
    const original = `${url}?sslmode=verify-full&application_name=sigae-test&options=-c%20statement_timeout%3D5000`;
    const client = createPrismaClient(original);
    const configured = new URL(state.adapterConfigs.at(-1)!.connectionString);
    const input = new URL(original);

    expect(configured.origin).toBe(input.origin);
    expect(configured.username).toBe(input.username);
    expect(configured.password).toBe(input.password);
    expect(configured.pathname).toBe(input.pathname);
    expect(configured.searchParams.get("sslmode")).toBe("verify-full");
    expect(configured.searchParams.get("application_name")).toBe("sigae-test");
    expect(configured.searchParams.get("options"))
      .toBe("-c statement_timeout=5000 -c TimeZone=UTC");
    const pgClient = new pg.Client({ connectionString: configured.toString() });
    const parameters = Reflect.get(pgClient, "connectionParameters") as { options?: string };
    expect(parameters.options)
      .toBe("-c statement_timeout=5000 -c TimeZone=UTC");
    await client.$disconnect();
    expect(state.disconnect).toHaveBeenCalled();
  });

  it("fija UTC también cuando la URL no trae options", () => {
    createPrismaClient(url);
    const configured = new URL(state.adapterConfigs.at(-1)!.connectionString);
    expect(configured.searchParams.get("options")).toBe("-c TimeZone=UTC");
  });

  it("falla antes de crear el adaptador y sin revelar una URL inválida", () => {
    const count = state.adapterConfigs.length;
    const secret = "clave-ficticia-no-imprimir";
    expect(() => createPrismaClient(`no-es-url:${secret}`)).toThrow("DATABASE_URL_INVALID");
    expect(state.adapterConfigs).toHaveLength(count);
  });

  it("API y CLI M1 comparten la fábrica; no hay otro constructor Prisma en backend", () => {
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return entry.name === "generated" ? [] : files(path);
      return /\.(ts|mts)$/.test(entry.name) ? [path] : [];
    });
    const factory = join(apiRoot, "src", "infrastructure", "database", "prisma-client.ts");
    for (const path of [...files(join(apiRoot, "src")), ...files(join(apiRoot, "scripts"))]) {
      if (path === factory) continue;
      expect(readFileSync(path, "utf8"), path)
        .not.toMatch(/new\s+(?:PrismaClient|PrismaPg)\s*\(/);
    }
    expect(readFileSync(join(apiRoot, "src", "bootstrap.ts"), "utf8"))
      .toContain('from "./infrastructure/database/prisma-client.js"');
    expect(readFileSync(join(apiRoot, "scripts", "m1-lab.ts"), "utf8"))
      .toContain('from "../src/infrastructure/database/prisma-client.js"');
  });
});
