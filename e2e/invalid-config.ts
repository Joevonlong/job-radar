/** Only the page-error run: break the disposable schedule after seeding, before the fresh web process starts. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const configDir = fs.realpathSync(process.env.JOB_RADAR_CONFIG_DIR ?? "");
const tempRoot = fs.realpathSync(os.tmpdir());
const dbName = new URL(process.env.DATABASE_URL ?? "").pathname.slice(1);
if (process.env.E2E_INVALID_CONFIG !== "schedule" || !dbName.startsWith("jobradar_e2e") || !configDir.startsWith(`${tempRoot}${path.sep}`)) {
  throw new Error("invalid-config requires a disposable e2e database and a config directory inside the temporary directory");
}
const file = path.join(configDir, "schedule.yaml");
fs.copyFileSync(file, path.join(configDir, ".schedule.valid-e2e"));
fs.writeFileSync(file, "timezone: [invalid\n");
