import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Cada import ocurre en otro proceso: nunca altera process.env del runner.
// Las URLs y contraseñas son sintéticas y no se abre ningún archivo .env.
const local = "postgresql://sigae_m2_itest:Example-Password_123.~@127.0.0.1:55432/sigae_m2_submit_itest";
const apiDirectory = fileURLToPath(new URL("..", import.meta.url));
const m1ConfigPath = fileURLToPath(new URL("../prisma.m1-lab.config.ts", import.meta.url));

type ChildOptions = {
  databaseUrl?: string | undefined;
  directUrl?: string | undefined;
  flag?: string;
};

function loadConfig({ databaseUrl, directUrl, flag }: ChildOptions = {}) {
  const environment: Record<string, string> = {};
  if (databaseUrl !== undefined) environment.DATABASE_URL = databaseUrl;
  if (directUrl !== undefined) environment.DIRECT_URL = directUrl;

  const script = `
    import { Socket } from "node:net";
    Socket.prototype.connect = function () { throw new Error("UNEXPECTED_CONNECTION"); };
    ${flag === undefined ? "" : `process.argv[1] = "prisma"; process.argv.push(${JSON.stringify(flag)});`}
    try {
      const { default: config } = await import("./prisma.m2-integration.config.ts");
      process.stdout.write(JSON.stringify({
        schema: config.schema,
        migrations: config.migrations,
        datasourceKeys: Object.keys(config.datasource ?? {}),
        matches: config.datasource?.url === process.env.DATABASE_URL,
      }));
    } catch (error) {
      process.stderr.write(String(error));
      process.exitCode = 7;
    }
  `;
  const child = spawnSync(process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    { cwd: apiDirectory, env: environment, encoding: "utf8", timeout: 15_000 });
  expect(child.error).toBeUndefined();
  return child;
}

describe("configuración Prisma 7 exclusiva de integración M2", () => {
  it("carga una URL sintética válida, conserva rutas y no conecta", () => {
    for (const directUrl of [undefined, local]) {
      const result = loadConfig({ databaseUrl: local, directUrl });
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        schema: "prisma/schema.prisma",
        migrations: { path: "prisma/migrations" },
        datasourceKeys: ["url"],
        matches: true,
      });
      expect(result.stderr).toBe("");
    }
  }, 20_000);

  it.each([
    ["DATABASE_URL ausente", undefined],
    ["base M1", local.replace("sigae_m2_submit_itest", "sigae_m1_test")],
    ["base de restauración", local.replace("sigae_m2_submit_itest", "sigae_restore_test")],
    ["base similar", local.replace("sigae_m2_submit_itest", "sigae_m2_submit_itest_copy")],
    ["Neon", local.replace("127.0.0.1", "ep-fictional.neon.tech")],
    ["host remoto", local.replace("127.0.0.1", "192.0.2.1")],
    ["usuario incorrecto", local.replace("sigae_m2_itest:", "postgres:")],
    ["puerto incorrecto", local.replace("55432", "5432")],
    ["parámetro extra", local + "?host=remote.invalid"],
  ])("falla de forma cerrada con %s", (_label, databaseUrl) => {
    const result = loadConfig({ databaseUrl });
    expect(result.status).toBe(7);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("M2IntegrationDatabaseError: Configuración PostgreSQL de integración M2 inválida.");
  });

  it("rechaza DIRECT_URL inconsistente", () => {
    const result = loadConfig({ databaseUrl: local,
      directUrl: local.replace("Example-Password_123.~", "Different-example") });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain("M2IntegrationDatabaseError");
  });

  it.each(["--url=postgresql://fictional:example@remote.invalid:5432/other",
    "--schema=other/schema.prisma", "--from-url=postgresql://fictional:example@remote.invalid:5432/other",
    "--to-url", "--shadow-database-url=postgresql://fictional:example@remote.invalid:5432/other"])(
    "rechaza el argumento de sobrescritura %s", (flag) => {
      const result = loadConfig({ databaseUrl: local, flag });
      expect(result.status).toBe(7);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("M2IntegrationDatabaseError: Configuración PostgreSQL de integración M2 inválida.");
    },
  );

  it("no carga .env ni usa un perfil alternativo cuando faltan variables", () => {
    const result = loadConfig();
    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain("UNEXPECTED_CONNECTION");
    expect(result.stderr).not.toContain(local);
  });

  it("no ejecuta migraciones al importar y deja intacta la configuración M1", () => {
    const before = readFileSync(m1ConfigPath);
    const result = loadConfig({ databaseUrl: local });
    expect(result.status).toBe(0);
    expect(readFileSync(m1ConfigPath)).toEqual(before);
    expect(result.stderr).not.toContain("UNEXPECTED_CONNECTION");
  });

  it("sanea los errores sin imprimir URL ni contraseña", () => {
    const secret = "Synthetic-secret-never-echo";
    const invalid = local.replace("Example-Password_123.~", secret) + "?host=remote.invalid";
    const result = loadConfig({ databaseUrl: invalid });
    expect(result.status).toBe(7);
    expect(result.stdout + result.stderr).not.toContain(secret);
    expect(result.stdout + result.stderr).not.toContain(invalid);
  });
});
