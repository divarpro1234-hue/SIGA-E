import { describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/infrastructure/database/prisma-client.js";

// Prueba de integración opt-in, exclusivamente SELECT. No se ejecuta en la suite normal.
const databaseUrl = process.env.SIGAE_DIAG_DATABASE_URL;
const enabled = process.env.SIGAE_RUN_REAL_DATE_TEST === "true" && !!databaseUrl;

describe.skipIf(!enabled)("PrismaPg TIMESTAMPTZ con PostgreSQL local real", () => {
  it("envía y recibe el mismo instante UTC", async () => {
    let target: URL;
    try {
      target = new URL(databaseUrl!);
    } catch {
      throw new Error("DIAG_DESTINATION_REJECTED");
    }
    if (!["postgres:", "postgresql:"].includes(target.protocol) ||
        target.hostname !== "127.0.0.1" || target.port !== "55432" ||
        target.pathname !== "/sigae_m1_test" || target.search || target.hash) {
      throw new Error("DIAG_DESTINATION_REJECTED");
    }

    const prisma = createPrismaClient(databaseUrl!);
    try {
      type Control = { db_name: string; session_zone: string; server_epoch: number;
        utc_epoch: number; server_date: Date };
      const [control] = await prisma.$queryRaw<Control[]>`
        WITH c AS MATERIALIZED (SELECT clock_timestamp() AS t)
        SELECT current_database() AS db_name,
               current_setting('TimeZone') AS session_zone,
               EXTRACT(EPOCH FROM c.t)::double precision AS server_epoch,
               EXTRACT(EPOCH FROM c.t AT TIME ZONE 'UTC')::double precision AS utc_epoch,
               c.t AS server_date FROM c`;
      expect(control?.db_name).toBe("sigae_m1_test");
      expect(control?.session_zone).toBe("UTC");

      const sent = new Date();
      type Probe = { received_epoch: number; returned_date: Date;
        server_epoch: number; server_date: Date };
      const [probe] = await prisma.$queryRaw<Probe[]>`
        WITH p AS MATERIALIZED (SELECT ${sent}::timestamptz AS t),
             c AS MATERIALIZED (SELECT clock_timestamp() AS t)
        SELECT EXTRACT(EPOCH FROM p.t)::double precision AS received_epoch,
               p.t AS returned_date,
               EXTRACT(EPOCH FROM c.t)::double precision AS server_epoch,
               c.t AS server_date FROM p CROSS JOIN c`;
      expect(probe).toBeDefined();
      const epoch = (date: Date) => date.getTime() / 1000;
      expect(Math.abs(control!.server_epoch - control!.utc_epoch)).toBeLessThan(0.01);
      expect(Math.abs(epoch(control!.server_date) - control!.server_epoch)).toBeLessThan(0.01);
      expect(Math.abs(probe!.received_epoch - epoch(sent))).toBeLessThan(0.01);
      expect(Math.abs(epoch(probe!.returned_date) - probe!.received_epoch)).toBeLessThan(0.01);
      expect(Math.abs(epoch(probe!.server_date) - probe!.server_epoch)).toBeLessThan(0.01);
      // No incluir URL ni errores del driver en la salida de la prueba.
    } catch {
      throw new Error("DIAG_READONLY_FAILED");
    } finally {
      await prisma.$disconnect().catch(() => {
        throw new Error("DIAG_DISCONNECT_FAILED");
      });
    }
  });
});
