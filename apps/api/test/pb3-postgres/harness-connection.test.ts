import { describe, expect, it } from "vitest";

import {
  openM5AnchorLab,
  guardedRead,
  assertM5LabIsEmptyForWorker,
} from "./harness.js";

type LaboratoryIdentity = {
  databaseName: string;
  username: string;
  host: string | null;
  port: number | null;
  dataDirectory: string;
  timeZone: string;
};

describe.skipIf(process.env["SIGAE_RUN_PB3_POSTGRES_ANCHOR"] !== "I_ACKNOWLEDGE_PB3_ANCHOR_WRITES")("PB3 PostgreSQL: conexion real protegida", () => {
  it("acepta exclusivamente el laboratorio y consulta sin modificar datos", async () => {
    const lab = await openM5AnchorLab();

    try {
      const rows = await guardedRead(
        lab.observer,
        (tx) => tx.$queryRaw<LaboratoryIdentity[]>`
          SELECT
            current_database()::text AS "databaseName",
            current_user::text AS "username",
            host(inet_server_addr()) AS "host",
            inet_server_port() AS "port",
            current_setting('data_directory') AS "dataDirectory",
            current_setting('TimeZone') AS "timeZone"
        `,
      );

      expect(rows).toHaveLength(1);

      const identity = rows[0]!;

      expect(identity.databaseName).toBe("sigae_pb3_lab");
      expect(identity.username).toBe("pb3_admin");
      expect(identity.host).toBe("127.0.0.1");
      expect(identity.port).toBe(55433);
      expect(identity.timeZone).toBe("UTC");

      expect(
        identity.dataDirectory.replace(/\\/g, "/").toLowerCase(),
      ).toBe("d:/desarrollo/sigae-pb3-postgres-lab/data");

      await assertM5LabIsEmptyForWorker(lab.writer);
    } finally {
      const cierres = await Promise.allSettled([
        lab.writer.$disconnect(),
        lab.observer.$disconnect(),
        lab.contender.$disconnect(),
        lab.lockClient.end(),
      ]);

      for (const cierre of cierres) {
        if (cierre.status === "rejected") {
          throw cierre.reason;
        }
      }
    }
  }, 30_000);
});
