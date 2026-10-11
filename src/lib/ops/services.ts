/**
 * Stop and restart the processes that read `.env`, from the host (`pnpm run setup --step telegram`). The same conventions
 * as scripts/ops/deploy.sh and the doctor:
 *
 * - the compose project is `COMPOSE_PROJECT_NAME` (environment / `.env`), else schedule.yaml `doctor.compose_project`;
 *   compose itself finds compose.yaml (and `COMPOSE_FILE`) in the working directory, the checkout;
 * - web and runner get `.env` through `env_file` when their container is created, so a plain `restart` keeps the old
 *   values: they are recreated (`up -d --no-deps --force-recreate --wait`), and only the ones that were running;
 * - the host ai-worker loads `.env` when it starts: `launchctl kickstart -k` of the agent named by schedule.yaml
 *   `doctor.ai_worker_launchd_label` (macOS), `systemctl --user restart` of its unit (Linux), only when it is installed
 *   and running.
 *
 * Nothing here throws: every operation reports ok / not ok with a short reason (no secret is ever part of a command).
 */
import type { CommandOutcome } from "@/lib/ops/doctor/types";

/** The compose services that read `.env` (compose.yaml `env_file`). */
export const ENV_FILE_SERVICES = ["web", "runner"] as const;
export type EnvFileService = (typeof ENV_FILE_SERVICES)[number];

export type CommandRunner = (command: string, args: readonly string[], timeoutMs: number) => Promise<CommandOutcome>;

export interface ServiceSettings {
  /** Compose project name (resolved like the doctor does). */
  project: string;
  platform: NodeJS.Platform;
  /** `process.getuid()`; null where there is none. */
  uid: number | null;
  launchdLabel: string;
  systemdUnit: string;
  /** Time-out of quick commands (ps, stop, logs, launchctl): schedule.yaml `doctor.command_timeout_seconds`. */
  commandTimeoutMs: number;
  /** How long a recreate may wait for healthy containers. */
  restartWaitSeconds: number;
}

export interface StepOutcome {
  ok: boolean;
  /** Last line of the command's error output (or why it did not run); empty when ok. */
  reason: string;
}

export type AiWorkerManager = "launchd" | "systemd";

export interface ServiceControl {
  readonly settings: ServiceSettings;
  /** The compose services that are running; null when Docker cannot be asked (not installed, not running). */
  runningServices(): Promise<string[] | null>;
  stop(service: EnvFileService): Promise<StepOutcome>;
  /** Start a stopped service again as it was (no new `.env` values). */
  start(service: EnvFileService): Promise<StepOutcome>;
  /** Recreate these services (and wait until healthy) so they read `.env` again. */
  recreate(services: readonly EnvFileService[]): Promise<StepOutcome>;
  /** How the ai-worker runs as a service of this user, when it is installed and running; null otherwise. */
  aiWorker(): Promise<AiWorkerManager | null>;
  restartAiWorker(manager: AiWorkerManager): Promise<StepOutcome>;
  /** The runner's log since `since`; null when it cannot be read. */
  runnerLogSince(since: Date): Promise<string | null>;
  /** The commands that do the same by hand (printed when something fails, or with `--no-restart`). */
  manualCommands(services: readonly EnvFileService[], aiWorker: AiWorkerManager | "unknown" | null): string[];
}

function lastLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (lines[lines.length - 1] ?? "").slice(0, 300);
}

function outcomeOf(result: CommandOutcome, command: string): StepOutcome {
  if (result.kind === "missing") return { ok: false, reason: `${command} not found` };
  if (result.kind === "timeout") return { ok: false, reason: `${command} timed out` };
  if (result.exitCode === 0) return { ok: true, reason: "" };
  return { ok: false, reason: lastLine(result.stderr) || lastLine(result.stdout) || `${command} exited with ${result.exitCode ?? "a signal"}` };
}

export function createServiceControl(settings: ServiceSettings, run: CommandRunner): ServiceControl {
  const compose = (args: readonly string[], timeoutMs = settings.commandTimeoutMs) => run("docker", ["compose", "-p", settings.project, ...args], timeoutMs);
  const domain = settings.uid === null ? null : `gui/${settings.uid}`;

  return {
    settings,
    async runningServices() {
      const result = await compose(["ps", "--status", "running", "--services"]);
      if (result.kind !== "ran" || result.exitCode !== 0) return null;
      return result.stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== "");
    },
    async stop(service) {
      // the runner stops gracefully (it has a shutdown grace of its own): allow more than a quick command
      return outcomeOf(await compose(["stop", service], settings.commandTimeoutMs * 4), "docker compose stop");
    },
    async start(service) {
      return outcomeOf(await compose(["start", service], settings.commandTimeoutMs * 4), "docker compose start");
    },
    async recreate(services) {
      if (services.length === 0) return { ok: true, reason: "" };
      const wait = settings.restartWaitSeconds;
      const result = await compose(["up", "-d", "--no-deps", "--force-recreate", "--wait", "--wait-timeout", String(wait), ...services], (wait + 60) * 1000);
      return outcomeOf(result, "docker compose up");
    },
    async aiWorker() {
      if (settings.platform === "darwin") {
        if (domain === null) return null;
        const result = await run("launchctl", ["print", `${domain}/${settings.launchdLabel}`], settings.commandTimeoutMs);
        return result.kind === "ran" && result.exitCode === 0 ? "launchd" : null;
      }
      if (settings.platform === "linux") {
        const result = await run("systemctl", ["--user", "is-active", settings.systemdUnit], settings.commandTimeoutMs);
        return result.kind === "ran" && result.exitCode === 0 && result.stdout.trim() === "active" ? "systemd" : null;
      }
      return null;
    },
    async restartAiWorker(manager) {
      if (manager === "launchd") {
        if (domain === null) return { ok: false, reason: "no user id" };
        return outcomeOf(await run("launchctl", ["kickstart", "-k", `${domain}/${settings.launchdLabel}`], settings.commandTimeoutMs), "launchctl kickstart");
      }
      return outcomeOf(await run("systemctl", ["--user", "restart", settings.systemdUnit], settings.commandTimeoutMs), "systemctl --user restart");
    },
    async runnerLogSince(since) {
      const result = await compose(["logs", "--no-color", "--since", since.toISOString(), "runner"]);
      return result.kind === "ran" && result.exitCode === 0 ? `${result.stdout}\n${result.stderr}` : null;
    },
    manualCommands(services, aiWorker) {
      const commands: string[] = [];
      if (services.length > 0) commands.push(`docker compose -p ${settings.project} up -d --no-deps --force-recreate ${services.join(" ")}`);
      const launchd = `launchctl kickstart -k gui/${settings.uid ?? "$(id -u)"}/${settings.launchdLabel}`;
      const systemd = `systemctl --user restart ${settings.systemdUnit}`;
      if (aiWorker === "launchd") commands.push(launchd);
      else if (aiWorker === "systemd") commands.push(systemd);
      else if (aiWorker === "unknown") commands.push(settings.platform === "darwin" ? launchd : settings.platform === "linux" ? systemd : "scripts/ops/install-ai-worker.sh");
      return commands;
    },
  };
}
