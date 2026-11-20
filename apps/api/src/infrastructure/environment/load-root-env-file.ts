import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const rootEnvironmentFile = fileURLToPath(new URL("../../../../../.env", import.meta.url));

export function loadRootEnvironmentFile(): void {
  if (existsSync(rootEnvironmentFile)) {
    loadEnvFile(rootEnvironmentFile);
  }
}
