import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parse, parseDocument } from "yaml";

import { configRegistry, LAYERED_CONFIG_NAMES, resetConfigCache, USER_CONFIG_NAMES } from "@/lib/config";

/**
 * A frozen snapshot of the shipped defaults, the single config fixture of the tests: `config/` of main d0f6f53
 * (2026-10-09), except ai.yaml / models.yaml / breakdown.yaml, which keep the earlier values the AI and settings tests
 * are written against (they had been frozen separately). The signal categories brought interests.yaml and notify.yaml to config_version 2 with its
 * migrations (their v1 originals are `tests/fixtures/config/interests.v1.yaml` / `notify.v1.yaml`, the migration tests' input). The Arbeitnow channel brought sources.yaml and pipeline.yaml to config_version 3 the same way (their migrations ran over the v2 files). The visa check added the `visa` sections of the generic and de packs' rules.yaml (as they shipped with it). Tests build their config from it and may assert its values; they never read the repository's `config/` for values (that directory becomes generic defaults,
 * see `REPO_DEFAULTS_DIR`). vitest points `JOB_RADAR_DEFAULTS_DIR` here for every test (vitest*.config.ts).
 */
export const FIXTURE_DEFAULTS_DIR = path.resolve(import.meta.dirname, "../fixtures/config/defaults");
/** The repository's real defaults directory: a test may only check that it is valid, never what it contains. */
export const REPO_DEFAULTS_DIR = path.resolve(import.meta.dirname, "../../config");
const SHIPPED_CONFIG_DIR = FIXTURE_DEFAULTS_DIR;

export interface TempConfig {
  root: string;
  /** The defaults directory (a copy of the fixture, ai.yaml routing pinned). */
  defaultsDir: string;
  /** The user config directory (what the app writes). */
  configDir: string;
  profileDir: string;
  cleanup: () => void;
}

export interface TempConfigOptions {
  /**
   * What the user directory starts with: `init` (default) = the `user` files, as `pnpm config:init` copies them (the
   * `shipped` ones, models.yaml and pipeline.yaml, are read from the defaults directory); `all` = every config file
   * (models / pipeline become user overrides); `empty` = nothing (everything is read from the defaults).
   */
  user?: "init" | "all" | "empty";
}

/**
 * The AI provider routing the tests are written against (global order codex-cli -> claude-cli -> api, api_order
 * anthropic -> deepseek -> mimo, only translate overridden), pinned so that the order the user saves in /settings
 * (it lands in the shipped ai.yaml, e.g. `tasks.score: {order: [codex-cli]}`) cannot change what the tests route to.
 */
export const PINNED_AI_ROUTING = {
  order: ["codex-cli", "claude-cli", "api"],
  api_order: ["anthropic", "deepseek", "mimo"],
  tasks: { score: {}, signals: {}, translate: { order: ["codex-cli", "claude-cli", "api"] }, summarize: {}, suggest: {} },
} as const;

/** Rewrite the routing keys of an ai.yaml file to `PINNED_AI_ROUTING` (comments and everything else stay). */
export function pinAiRouting(file: string): void {
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  for (const [key, value] of Object.entries(PINNED_AI_ROUTING)) doc.set(key, doc.createNode(structuredClone(value)));
  fs.writeFileSync(file, doc.toString());
}

const CONFIG_ENV = ["JOB_RADAR_DEFAULTS_DIR", "JOB_RADAR_CONFIG_DIR", "JOB_RADAR_PROFILE_DIR", "JOB_RADAR_CONFIG_POLL_MS"] as const;

/**
 * A temp defaults directory (a copy of the fixture snapshot, its ai.yaml routing pinned, see `PINNED_AI_ROUTING`), a temp
 * user directory filled per `options.user`, and a temp profile directory; points the config module at them. `cleanup`
 * restores the environment it found.
 */
export function makeTempConfig(options: TempConfigOptions = {}): TempConfig {
  const saved = new Map(CONFIG_ENV.map((key) => [key, process.env[key]]));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-config-"));
  const defaultsDir = path.join(root, "defaults");
  const configDir = path.join(root, "config");
  const profileDir = path.join(root, "profile");
  fs.cpSync(SHIPPED_CONFIG_DIR, defaultsDir, { recursive: true });
  pinAiRouting(path.join(defaultsDir, "ai.yaml"));
  fs.mkdirSync(configDir);
  const user = options.user ?? "init";
  const names = user === "all" ? LAYERED_CONFIG_NAMES : user === "init" ? USER_CONFIG_NAMES : [];
  for (const name of names) fs.copyFileSync(path.join(defaultsDir, configRegistry[name].file), path.join(configDir, configRegistry[name].file));
  process.env.JOB_RADAR_DEFAULTS_DIR = defaultsDir;
  process.env.JOB_RADAR_CONFIG_DIR = configDir;
  process.env.JOB_RADAR_PROFILE_DIR = profileDir;
  resetConfigCache();
  return {
    root,
    defaultsDir,
    configDir,
    profileDir,
    cleanup: () => {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetConfigCache();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/**
 * Parsed YAML of the fixture snapshot (as plain JS) for building good/bad inputs; `relativePath` like `ai.yaml`, `profile.example/me.yaml`.
 * `config_version` is left out: it is the loader's business, not the schema's.
 */
export function shippedYaml(relativePath: string): Record<string, unknown> {
  const parsed: unknown = parse(fs.readFileSync(path.join(SHIPPED_CONFIG_DIR, relativePath), "utf8"));
  if (typeof parsed !== "object" || parsed === null) throw new Error(`bad fixture ${relativePath}`);
  // `config_version` is handled outside the schemas: the raw fixtures are compared with them without it
  const rest = { ...(parsed as Record<string, unknown>) };
  delete rest.config_version;
  return rest;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` is true or `timeoutMs` passes. */
export async function waitFor(predicate: () => boolean, timeoutMs = 2000, stepMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}
