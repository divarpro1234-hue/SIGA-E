import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

import { defineConfig } from "prisma/config";
import { M1LabDatabaseError, validateM1LabDatabase } from "./src/config/m1-lab-database.js";
import { assertLocalSoloLabOnlyM4Config } from "./scripts/m4-local-solo-authorization.js";

assertLocalSoloLabOnlyM4Config(process.env);

const rootEnvironmentFile = fileURLToPath(new URL("../../.env", import.meta.url));

if (process.env.SIGAE_M1_LAB === undefined && existsSync(rootEnvironmentFile)) {
  loadEnvFile(rootEnvironmentFile);
  if (process.env.SIGAE_M1_LAB !== undefined) throw new M1LabDatabaseError();
}

assertLocalSoloLabOnlyM4Config(process.env);

const directUrl = process.env.SIGAE_M1_LAB === undefined
  ? process.env.DIRECT_URL
  : validateM1LabDatabase(process.env);

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  ...(directUrl === undefined || directUrl.length === 0
    ? {}
    : { datasource: { url: directUrl } }),
});
