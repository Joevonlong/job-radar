/** The real probes of `pnpm run doctor`: child processes, HTTP, the filesystem and the database. Host-side only. */
import { execFile, spawn } from "node:child_process";
import { lstat, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { getAppRoot, inspectConfigLayers, loadConfig } from "@/lib/config";
import { getDb, getDbNow, pingDb, readAppliedMigrations } from "@/lib/db";
import { readJournal } from "@/lib/db/migration-journal";
import { countUnscoredJobs } from "@/lib/db/repos/scores";
import { countTrapStats, trapTablesReady } from "@/lib/db/repos/traps";
import { ConfigError, firstConfigProblem } from "@/lib/config/errors";
import { summarizeMarket } from "@/lib/market/summary";
import { readProfileReadiness } from "@/lib/scoring/profile";
import { readSetupState } from "@/lib/setup/state";
import { loadRunnerEnv } from "@/lib/env";
import { translatorFor } from "@/lib/i18n/node";
import { cliLocaleFrom } from "@/lib/i18n/config";
import { loadSourcesView } from "@/lib/sources/load";
import { loadRegistryPage } from "@/lib/sources/registry/load";

import { listBackups } from "../backup";
import { measureDisk, sameVolume } from "../disk";
import { resolveDockerDataLocation } from "../docker-data";
import { redact } from "./helpers";
import { resolveHostDatabaseUrl } from "./database-url";
import type { CommandOutcome, DiskSpace, DoctorContext, DoctorProbes, HttpOutcome, OwnershipScan, TrapsProbe } from "./types";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const MAX_BODY_CHARS = 4096;
/** A detached command that outlives its time-out: SIGTERM to its process group, SIGKILL this much later. */
const KILL_GRACE_MS = 5000;
/** After the child exits, how long to wait for its output pipes to close (a grandchild may keep them open). */
const CLOSE_GRACE_MS = 2000;

/** Walk `roots` (without following symlinks) and collect what is not owned by `uid` (`data.ownership`). */
export async function scanOwnership(roots: readonly string[], uid: number, options: { sample: number; maxEntries: number }): Promise<OwnershipScan> {
  const result: OwnershipScan = { scanned: 0, foreign: 0, sample: [], truncated: false };
  const queue: string[] = [];
  for (const root of roots) {
    try {
      await lstat(root);
      queue.push(root);
    } catch {
      // not there: nothing to own
    }
  }
  const note = (entry: string): void => {
    result.foreign += 1;
    if (result.sample.length < options.sample) result.sample.push(entry);
  };
  while (queue.length > 0) {
    if (result.scanned >= options.maxEntries) {
      result.truncated = true;
      break;
    }
    const entry = queue.shift() as string;
    result.scanned += 1;
    let info;
    try {
      info = await lstat(entry);
    } catch {
      note(entry);
      continue;
    }
    if (info.uid !== uid) note(entry);
    if (!info.isDirectory()) continue;
    try {
      for (const name of await readdir(entry)) queue.push(path.join(entry, name));
    } catch {
      // a directory this user cannot list is reported by its owner above when it is foreign
    }
  }
  return result;
}

export interface RunCommandOptions {
  /** The child's environment (default: this process's). */
  env?: NodeJS.ProcessEnv;
  /**
   * Run the child in a process group of its own, so a Ctrl-C at the terminal (SIGINT to the foreground group) does not
   * reach it and it runs to completion: for commands that must not be cut half-way (recreating containers).
   */
  detached?: boolean;
  /** Detached only: SIGTERM -> SIGKILL delay of the process group after the time-out (default `KILL_GRACE_MS`). */
  killGraceMs?: number;
  /** Detached only: how long to wait for the pipes after the exit (default `CLOSE_GRACE_MS`). */
  closeGraceMs?: number;
}

/** Run a command to completion (time-out in ms). `ENOENT` is "missing", a kill by the time-out is "timeout"; a non-zero exit is a normal outcome. */
export function runCommand(command: string, args: readonly string[], timeoutMs: number, options: RunCommandOptions = {}): Promise<CommandOutcome> {
  if (options.detached) return runDetached(command, args, timeoutMs, options);
  return new Promise((resolve) => {
    const extra = options.env ? { env: options.env } : {};
    execFile(command, [...args], { timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8", windowsHide: true, ...extra }, (error, stdout, stderr) => {
      if (error === null) {
        resolve({ kind: "ran", exitCode: 0, stdout, stderr });
        return;
      }
      const code: unknown = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") resolve({ kind: "missing" });
      else if (error.killed || code === "ETIMEDOUT") resolve({ kind: "timeout" });
      else resolve({ kind: "ran", exitCode: typeof code === "number" ? code : null, stdout, stderr });
    });
  });
}

/**
 * `runCommand` in a process group of its own (`execFile` has no `detached`): same outcomes, output cut at the same size.
 * On the time-out the whole group gets SIGTERM, then SIGKILL after `killGraceMs`; the result comes on the exit (the pipes
 * get `closeGraceMs` to drain: a grandchild such as the compose plugin may hold them open), so it always settles.
 */
function runDetached(command: string, args: readonly string[], timeoutMs: number, options: RunCommandOptions): Promise<CommandOutcome> {
  const killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
  const closeGraceMs = options.closeGraceMs ?? CLOSE_GRACE_MS;
  return new Promise((resolve) => {
    const timers: NodeJS.Timeout[] = [];
    const later = (ms: number, run: () => void): void => {
      timers.push(setTimeout(run, ms));
    };
    const child = spawn(command, [...args], { detached: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(options.env ? { env: options.env } : {}) });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let exitCode: number | null = null;
    let settled = false;
    const settle = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(outcome);
    };
    const result = (): CommandOutcome => (timedOut ? { kind: "timeout" } : { kind: "ran", exitCode, stdout, stderr });
    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        // the group is gone already
      }
    };
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk;
    });
    later(timeoutMs, () => {
      timedOut = true;
      killGroup("SIGTERM");
      later(killGraceMs, () => {
        killGroup("SIGKILL");
        // a process that survives SIGKILL (uninterruptible sleep) must not hold the caller forever
        later(closeGraceMs, () => settle(result()));
      });
    });
    child.on("error", (error: NodeJS.ErrnoException) => settle(error.code === "ENOENT" ? { kind: "missing" } : { kind: "ran", exitCode: null, stdout, stderr: stderr || error.message }));
    child.on("exit", (code) => {
      exitCode = code;
      later(closeGraceMs, () => settle(result()));
    });
    child.on("close", () => settle(result()));
  });
}

/** GET with a time-out. Never throws; the body is cut at 4 KB. */
export async function httpGet(url: string, timeoutMs: number): Promise<HttpOutcome> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual" });
    const body = (await response.text()).slice(0, MAX_BODY_CHARS);
    return { ok: response.ok, status: response.status, body, error: null };
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error && "code" in error.cause ? String(error.cause.code) : null;
    const name = error instanceof Error ? error.name : "error";
    return { ok: false, status: null, body: null, error: cause ?? (name === "TimeoutError" ? "timeout" : redact(name)) };
  }
}

/**
 * The dashboard as the host sees it: `JOB_RADAR_DOCTOR_WEB_URL`, else derived from the published port and bind address
 * when `.env` sets either (`JOB_RADAR_WEB_PORT`, `JOB_RADAR_WEB_BIND`; `0.0.0.0` is reached on 127.0.0.1), else
 * schedule.yaml `doctor.web_url`.
 */
export function resolveDoctorWebUrl(env: Readonly<Record<string, string | undefined>>, configured: string): string {
  const override = (env.JOB_RADAR_DOCTOR_WEB_URL ?? "").trim();
  if (override !== "") return z.url({ protocol: /^https?$/ }).parse(override);
  const port = (env.JOB_RADAR_WEB_PORT ?? "").trim();
  const bind = (env.JOB_RADAR_WEB_BIND ?? "").trim();
  if (port === "" && bind === "") return configured;
  const host = bind === "" || bind === "0.0.0.0" ? "127.0.0.1" : bind;
  const portNumber = port === "" ? 3000 : Number(port);
  if (!/^\d{1,5}$/.test(port === "" ? "3000" : port) || portNumber < 1 || portNumber > 65535 || !/^[0-9.]+$/.test(host)) return configured;
  return `http://${host}:${portNumber}`;
}

/** The compose project: `COMPOSE_PROJECT_NAME` (what docker compose itself reads from `.env`), else schedule.yaml `doctor.compose_project`. */
export function resolveComposeProject(env: Readonly<Record<string, string | undefined>>, configured: string): string {
  const fromEnv = (env.COMPOSE_PROJECT_NAME ?? "").trim();
  return /^[a-z0-9][a-z0-9_-]*$/.test(fromEnv) ? fromEnv : configured;
}

export interface RealProbeOptions {
  commandTimeoutMs: number;
  probeTimeoutMs: number;
  now: () => Date;
  migrationsDir: string;
}

export function createRealProbes(options: RealProbeOptions): DoctorProbes {
  return {
    run: (command, args) => runCommand(command, args, options.commandTimeoutMs),
    http: (url) => httpGet(url, options.probeTimeoutMs),
    dbPing: () => pingDb(getDb()),
    async migrations() {
      const [expected, applied] = await Promise.all([readJournal(options.migrationsDir), readAppliedMigrations(getDb())]);
      return { expected, applied };
    },
    sources: () => loadSourcesView(options.now()),
    registry: () => loadRegistryPage({ syncMirror: false }),
    unscoredJobs: () => countUnscoredJobs(getDb()),
    traps: (now) => probeTraps(now),
    profile: async () => readProfileReadiness(),
    async backups(directory) {
      try {
        if (!(await stat(directory)).isDirectory()) return null;
      } catch {
        return null;
      }
      return listBackups(directory);
    },
    disk: (target): Promise<DiskSpace | null> => measureDisk(target),
    dockerData: () => resolveDockerDataLocation(),
    sameVolume: (a, b) => sameVolume(a, b),
    async listDir(directory) {
      try {
        return await readdir(directory);
      } catch {
        return null;
      }
    },
    configLayers: () => inspectConfigLayers(),
    foreignOwned: (roots, uid, options) => scanOwnership(roots, uid, options),
    market: async () => summarizeMarket(),
    setup: async () => readSetupState(),
  };
}

/** Build the context of a real run: config from the YAML files, settings from the environment, probes against this machine. */
export async function createRealContext(env: Readonly<Record<string, string | undefined>> = process.env, options: { lang?: string } = {}): Promise<DoctorContext> {
  // getDb() reads process.env.DATABASE_URL; derive it from the compose-style variables when it is not set.
  if ((process.env.DATABASE_URL ?? "").trim() === "") process.env.DATABASE_URL = resolveHostDatabaseUrl(env);

  const schedule = loadConfig("schedule");
  const settings = { ...schedule.doctor, web_url: resolveDoctorWebUrl(env, schedule.doctor.web_url), compose_project: resolveComposeProject(env, schedule.doctor.compose_project) };
  const runnerEnv = loadRunnerEnv(env);

  // All stamps come from one instant; the database clock when it answers, so heartbeats and runs compare like for like.
  let now = new Date();
  try {
    if (await pingDb(getDb())) now = await getDbNow(getDb());
  } catch {
    // keep the host clock
  }

  const migrationsDir = path.resolve(env.MIGRATIONS_DIR?.trim() ? env.MIGRATIONS_DIR.trim() : "drizzle");
  // language.yaml, read tolerantly (i18n.config reports a problem); --lang wins over cli.locale
  let language = null;
  let languageProblem: string | null = null;
  try {
    language = loadConfig("language");
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    languageProblem = firstConfigProblem(error);
  }
  const locale = cliLocaleFrom(language, options.lang);
  return {
    now,
    locale,
    t: translatorFor(locale, "doctor"),
    env,
    platform: process.platform,
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    config: { schedule, notify: loadConfig("notify"), ai: loadConfig("ai"), channels: loadConfig("channels"), language, languageProblem },
    settings,
    backupDir: path.resolve(runnerEnv.RUNNER_BACKUP_DIR),
    appRoot: getAppRoot(),
    runnerMaxAgeSeconds: runnerEnv.RUNNER_HEALTH_MAX_AGE_SECONDS,
    probes: createRealProbes({ commandTimeoutMs: settings.command_timeout_seconds * 1000, probeTimeoutMs: settings.probe_timeout_seconds * 1000, now: () => now, migrationsDir }),
  };
}

/** `data.traps`: traps.yaml and the counts; a missing table is `stats: null`, not an error. */
async function probeTraps(now: Date): Promise<TrapsProbe> {
  let settings;
  try {
    settings = loadConfig("traps");
  } catch (error) {
    if (error instanceof ConfigError) return { state: "config_error", problem: firstConfigProblem(error) };
    throw error;
  }
  const base = { state: "ok" as const, enabled: settings.enabled, backlogWarn: settings.scan.backlog_warn, recentDays: settings.scan.recent_days };
  const db = getDb();
  if (!(await trapTablesReady(db))) return { ...base, stats: null };
  const since = new Date(now.getTime() - settings.scan.recent_days * 86_400_000);
  return { ...base, stats: await countTrapStats(db, { since }) };
}
