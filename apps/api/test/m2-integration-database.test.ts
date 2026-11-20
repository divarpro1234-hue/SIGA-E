import { describe, expect, it } from "vitest";

import {
  M2IntegrationDatabaseError,
  validateM2IntegrationDatabase,
} from "../src/config/m2-integration-database.js";

// Exclusivamente fixtures sintéticos; nunca se construye un cliente PostgreSQL.
const local = "postgresql://sigae_m2_itest:Example-Password_123.~@127.0.0.1:55432/sigae_m2_submit_itest";

describe("guard PostgreSQL aislado M2 (sin conexión)", () => {
  it.each([local, local.replace("postgresql:", "postgres:")])(
    "acepta el destino dedicado con uno o dos valores explícitos (%#)", (url) => {
      expect(validateM2IntegrationDatabase({ DATABASE_URL: url })).toBeUndefined();
      expect(validateM2IntegrationDatabase({ DATABASE_URL: url, DIRECT_URL: url })).toBeUndefined();
    },
  );

  it.each([
    ["usuario distinto", local.replace("sigae_m2_itest:", "postgres:")],
    ["usuario codificado", local.replace("sigae_m2_itest:", "%73igae_m2_itest:")],
    ["M1", local.replace("sigae_m2_submit_itest", "sigae_m1_test")],
    ["restauración", local.replace("sigae_m2_submit_itest", "sigae_restore_test")],
    ["otra base", local + "_copy"],
    ["base codificada", local.replace("/sigae", "/%73igae")],
    ["host remoto", local.replace("127.0.0.1", "192.0.2.1")],
    ["Neon", local.replace("127.0.0.1", "ep-fictional.neon.tech")],
    ["localhost", local.replace("127.0.0.1", "localhost")],
    ["IPv6", local.replace("127.0.0.1", "[::1]")],
    ["IPv6 mapeada", local.replace("127.0.0.1", "[::ffff:127.0.0.1]")],
    ["host abreviado", local.replace("127.0.0.1", "127.1")],
    ["host decimal", local.replace("127.0.0.1", "2130706433")],
    ["host hexadecimal", local.replace("127.0.0.1", "0x7f000001")],
    ["host codificado", local.replace("127.0.0.1", "%31%32%37.0.0.1")],
    ["host con punto final", local.replace("127.0.0.1", "127.0.0.1.")],
    ["puerto distinto", local.replace("55432", "5432")],
    ["puerto ausente", local.replace(":55432", "")],
    ["puerto con cero", local.replace("55432", "055432")],
    ["query host", local + "?host=remote.invalid"],
    ["query options", local + "?options=-c%20search_path=public"],
    ["query schema", local + "?schema=public"],
    ["query sslmode", local + "?sslmode=disable"],
    ["query vacía", local + "?"],
    ["fragmento", local + "#remote"],
    ["fragmento vacío", local + "#"],
    ["ruta adicional", local + "/extra"],
    ["barra final", local + "/"],
    ["segmento punto", local.replace("/sigae_m2_submit", "/./sigae_m2_submit")],
    ["traversal", local.replace("/sigae_m2_submit", "/other/../sigae_m2_submit")],
    ["doble autoridad", local.replace("@127", "@remote.invalid@127")],
    ["varios hosts", local.replace("127.0.0.1", "remote.invalid,127.0.0.1")],
    ["contraseña vacía", local.replace("Example-Password_123.~", "")],
    ["contraseña codificada", local.replace("Example-Password_123.~", "%41")],
    ["escape malformado", local.replace("Example-Password_123.~", "%GG")],
    ["doble escape", local.replace("Example-Password_123.~", "%2540")],
    ["barra inversa", local.replace("Example-Password_123.~", "example\\password")],
    ["Unicode", local.replace("Example-Password_123.~", "ejemploñ")],
    ["espacio inicial", " " + local],
    ["espacio final", local + " "],
    ["salto final", local + "\n"],
    ["CRLF final", local + "\r\n"],
    ["tabulador", local.replace("127", "\t127")],
    ["NUL", local + "\u0000"],
    ["DEL", local.replace("Example-Password_123.~", "example\u007f")],
    ["esquema distinto", local.replace("postgresql:", "https:")],
    ["mayúsculas", local.replace("postgresql:", "POSTGRESQL:")],
    ["URL malformada", "postgresql://"],
    ["conninfo", "host=127.0.0.1 port=55432 dbname=sigae_m2_submit_itest"],
  ])("rechaza %s en cualquiera de las URLs", (_label, url) => {
    expect(() => validateM2IntegrationDatabase({ DATABASE_URL: url })).toThrow(M2IntegrationDatabaseError);
    expect(() => validateM2IntegrationDatabase({ DATABASE_URL: local, DIRECT_URL: url })).toThrow(M2IntegrationDatabaseError);
  });

  it.each([undefined, null, "", local, 42, [], {}, { DIRECT_URL: local },
    { DATABASE_URL: undefined }, { DATABASE_URL: null }, { DATABASE_URL: "" },
    { DATABASE_URL: 42 }, { DATABASE_URL: new URL(local) },
    { DATABASE_URL: local, DIRECT_URL: undefined }, { DATABASE_URL: local, DIRECT_URL: null },
    { DATABASE_URL: local, DIRECT_URL: "" },
  ])("rechaza entradas ausentes o de tipo incorrecto (%#)", (source) => {
    expect(() => validateM2IntegrationDatabase(source)).toThrow(M2IntegrationDatabaseError);
  });

  it.each([local.replace("Example-Password_123.~", "Another-example"), local.replace("postgresql:", "postgres:")])(
    "exige igualdad textual de ambas URLs (%#)", (direct) => {
      expect(() => validateM2IntegrationDatabase({ DATABASE_URL: local, DIRECT_URL: direct }))
        .toThrow(M2IntegrationDatabaseError);
    },
  );

  it.each(["allowedDatabase", "database", "host", "user", "connectionString", "PGHOST",
    "PGDATABASE", "PGOPTIONS", "NEON_DATABASE_URL", "SIGAE_M1_LAB", "SIGAE_TEST_DIRECT_URL"])(
    "rechaza propiedades arbitrarias sin ampliar el destino: %s", (key) => {
      for (const url of [local, local.replace("sigae_m2_submit_itest", "sigae_m1_test")]) {
        expect(() => validateM2IntegrationDatabase({ DATABASE_URL: url, [key]: "sigae_m1_test" }))
          .toThrow(M2IntegrationDatabaseError);
      }
    },
  );

  it("rechaza propiedades heredadas, símbolos y accesores sin ejecutarlos", () => {
    let reads = 0;
    const accessor = { get DATABASE_URL() { reads += 1; return local; } };
    for (const source of [accessor, Object.create({ DATABASE_URL: local }),
      { DATABASE_URL: local, [Symbol("override")]: "other" }]) {
      expect(() => validateM2IntegrationDatabase(source)).toThrow(M2IntegrationDatabaseError);
    }
    expect(reads).toBe(0);
  });

  it("no muta ni devuelve las entradas o las credenciales", () => {
    const source = Object.freeze({ DATABASE_URL: local, DIRECT_URL: local });
    expect(validateM2IntegrationDatabase(source)).toBeUndefined();
    expect(source).toEqual({ DATABASE_URL: local, DIRECT_URL: local });
  });

  it("todos los errores son constantes y no contienen URL, contraseña ni causa", () => {
    const secret = "Synthetic-secret-never-echo";
    const invalid = local.replace("Example-Password_123.~", secret) + "?host=remote.invalid";
    const throwingObject = new Proxy({}, { getPrototypeOf() { throw new Error(secret); } });
    for (const source of [{ DATABASE_URL: invalid },
      { DATABASE_URL: local, DIRECT_URL: invalid }, throwingObject]) {
      let caught: unknown;
      try { validateM2IntegrationDatabase(source); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(M2IntegrationDatabaseError);
      const error = caught as M2IntegrationDatabaseError;
      expect(error.message).toBe("Configuración PostgreSQL de integración M2 inválida.");
      expect(error.cause).toBeUndefined();
      for (const representation of [String(error), error.stack, JSON.stringify(error)]) {
        expect(representation).not.toContain(secret);
        expect(representation).not.toContain(invalid);
        expect(representation).not.toContain(local);
      }
    }
  });
});
