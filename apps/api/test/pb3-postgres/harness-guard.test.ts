import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Barrera de seguridad: nunca crear clientes reales durante estas pruebas.
vi.mock("pg", () => ({
  Client: class {
    constructor() {
      throw new Error("STOP_PG_CLIENT_FORBIDDEN");
    }
  },
}));

vi.mock("../../src/infrastructure/database/prisma-client.js", () => ({
  createPrismaClient: () => {
    throw new Error("STOP_PRISMA_CLIENT_FORBIDDEN");
  },
}));

import { openM5AnchorLab } from "./harness.js";

const OPT_IN = "I_ACKNOWLEDGE_PB3_ANCHOR_WRITES";

const VALID_LAB_URL =
  "postgresql://pb3_admin:FAKE_PASSWORD@127.0.0.1:55433/sigae_pb3_lab";

const VARIABLES = [
  "SIGAE_RUN_PB3_POSTGRES_ANCHOR",
  "SIGAE_PB3_POSTGRES_URL",
  "SIGAE_PB3_POSTGRES_DIRECT_URL",
] as const;

const previous = new Map(
  VARIABLES.map((name) => [name, process.env[name]]),
);

describe("PB3: bloqueo de destinos no autorizados (sin red)", () => {
  beforeEach(() => {
    process.env.SIGAE_RUN_PB3_POSTGRES_ANCHOR = OPT_IN;
    process.env.SIGAE_PB3_POSTGRES_URL = VALID_LAB_URL;

    delete process.env.SIGAE_PB3_POSTGRES_DIRECT_URL;
  });

  afterEach(() => {
    for (const name of VARIABLES) {
      const original = previous.get(name);

      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  const casos = [
    {
      nombre: "sin autorizacion explicita",
      modificar: () => {
        delete process.env.SIGAE_RUN_PB3_POSTGRES_ANCHOR;
      },
    },
    {
      nombre: "sin URL",
      modificar: () => {
        delete process.env.SIGAE_PB3_POSTGRES_URL;
      },
    },
    {
      nombre: "usuario diferente",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_URL =
          VALID_LAB_URL.replace("pb3_admin:", "otro_usuario:");
      },
    },
    {
      nombre: "base de datos diferente",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_URL =
          VALID_LAB_URL.replace("/sigae_pb3_lab", "/otra_base");
      },
    },
    {
      nombre: "puerto original 55432",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_URL =
          VALID_LAB_URL.replace(":55433/", ":55432/");
      },
    },
    {
      nombre: "hostname localhost",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_URL =
          VALID_LAB_URL.replace("127.0.0.1", "localhost");
      },
    },
    {
      nombre: "parametros de conexion adicionales",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_URL =
          VALID_LAB_URL + "?sslmode=disable";
      },
    },
    {
      nombre: "DIRECT_URL diferente",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_DIRECT_URL =
          VALID_LAB_URL.replace(":55433/", ":55432/");
      },
    },
    {
      nombre: "contrasena ausente",
      modificar: () => {
        process.env.SIGAE_PB3_POSTGRES_URL =
          VALID_LAB_URL.replace("FAKE_PASSWORD", "");
      },
    },
  ];

  it.each(casos)("rechaza $nombre", async ({ modificar }) => {
    modificar();

    await expect(openM5AnchorLab()).rejects.toThrow(
      "PB3_ANCHOR_HARNESS_DESTINATION_REJECTED",
    );
  });
});
