/**
 * `pnpm start` / `pnpm dev`: runs `next start` / `next dev` listening on `JOB_RADAR_WEB_BIND` (from the environment or
 * the `.env` files, read the way Next reads them) and tells the web which address it listens on, so the local login
 * exemption is only on when nobody but this machine can connect (`src/lib/security/web-listen.ts`).
 *
 *   tsx scripts/web-run.ts start [next arguments...]
 *   tsx scripts/web-run.ts dev [next arguments...]
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";

import { WEB_BIND_ENV } from "../src/lib/security/local-request";
import { planWebListen } from "../src/lib/security/web-listen";

const mode = process.argv[2];
if (mode !== "start" && mode !== "dev") {
  console.error("usage: tsx scripts/web-run.ts start|dev [next arguments...]");
  process.exit(2);
}

const require = createRequire(import.meta.url);
const nextRequire = createRequire(require.resolve("next/package.json"));

/** `JOB_RADAR_WEB_BIND` as Next will see it: the environment first, then `.env*` (`@next/env`, Next's own loader). */
function bindFromEnvFiles(): string | undefined {
  const fromEnvironment = process.env[WEB_BIND_ENV];
  if (fromEnvironment !== undefined) return fromEnvironment;
  const loaded: unknown = nextRequire("@next/env");
  if (typeof loaded !== "object" || loaded === null || !("loadEnvConfig" in loaded) || typeof loaded.loadEnvConfig !== "function") return undefined;
  const result: unknown = loaded.loadEnvConfig(process.cwd(), mode === "dev", { info: () => undefined, error: (...args: unknown[]) => console.error(...args) });
  if (typeof result !== "object" || result === null || !("combinedEnv" in result)) return undefined;
  const combined = result.combinedEnv;
  if (typeof combined !== "object" || combined === null) return undefined;
  const value: unknown = (combined as Record<string, unknown>)[WEB_BIND_ENV];
  return typeof value === "string" ? value : undefined;
}

// the environment the Next process starts with: what this process got, not what the loader added (Next loads .env itself)
const baseEnv = { ...process.env };
const plan = planWebListen(process.argv.slice(3), bindFromEnvFiles());
const child = spawn(process.execPath, [nextRequire.resolve("./dist/bin/next"), mode, ...plan.args], {
  stdio: "inherit",
  env: { ...baseEnv, [WEB_BIND_ENV]: plan.bind },
});
child.on("error", (error) => {
  console.error(`web-run: cannot start next ${mode}: ${error.message}`);
  process.exit(1);
});
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
child.on("exit", (code, signal) => {
  process.exit(signal !== null ? 128 + (constants.signals[signal] ?? 0) : (code ?? 1));
});
