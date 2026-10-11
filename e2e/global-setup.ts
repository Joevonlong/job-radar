import { spawn, type ChildProcess } from "node:child_process";

/**
 * Starts `scripts/e2e-runner.ts` (a stand-in for the runner: heartbeat, config-loaded acknowledgement,
 * control-request poller) once the web server — and with it the disposable database — is ready, and
 * stops it after the run. The settings e2e needs a "runner" to answer "run a cycle now" and to
 * acknowledge saved configuration.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const child: ChildProcess = spawn("pnpm", ["exec", "tsx", "scripts/e2e-runner.ts"], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.E2E_DATABASE_URL ?? "",
      JOB_RADAR_CONFIG_DIR: process.env.E2E_CONFIG_DIR ?? "",
      JOB_RADAR_DEFAULTS_DIR: process.env.E2E_DEFAULTS_DIR ?? "",
      JOB_RADAR_PROFILE_DIR: process.env.E2E_PROFILE_DIR ?? "",
    },
    stdio: ["ignore", "pipe", "inherit"],
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("e2e-runner did not become ready within 60 s")), 60_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`e2e-runner exited early with code ${code}`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("e2e-runner: ready")) {
        clearTimeout(timer);
        child.removeAllListeners("exit");
        resolve();
      }
    });
  });

  return async () => {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const force = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(force);
          resolve();
        });
      });
    }
  };
}
