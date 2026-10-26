/** Run the real CLI bundled into a disposable app, so config:init cannot inspect the installation's .env or Docker. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { buildSync } from "esbuild";

import type { TempConfig } from "./helpers";

export function runConfigScript(tmp: TempConfig, script: string, args: string[] = [], env: Record<string, string> = {}) {
  const repo = path.resolve(import.meta.dirname, "../..");
  const output = path.join(tmp.root, "scripts", script.replace(/\.ts$/, ".mjs"));
  fs.writeFileSync(path.join(tmp.root, "package.json"), '{"name":"job-radar","type":"module"}');
  if (!fs.existsSync(path.join(tmp.root, "node_modules"))) fs.symlinkSync(path.join(repo, "node_modules"), path.join(tmp.root, "node_modules"), "dir");
  buildSync({ entryPoints: [path.join(repo, "scripts", script)], outfile: output, bundle: true, platform: "node", format: "esm", packages: "external", tsconfig: path.join(repo, "tsconfig.json") });
  const result = spawnSync(process.execPath, [output, ...args], {
    cwd: tmp.root, env: { ...process.env, JOB_RADAR_CONFIG_DIR: tmp.configDir, JOB_RADAR_PROFILE_DIR: tmp.profileDir, JOB_RADAR_DEFAULTS_DIR: tmp.defaultsDir, ...env }, encoding: "utf8", timeout: 60000,
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}
