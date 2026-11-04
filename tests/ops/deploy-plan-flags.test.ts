// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DEPLOY_WRITE_PLAN, planConfigWrites } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { runConfigScript } from "../config/run-script";

/**
 * What `deploy.sh` writes (the write step's commands and their flags) and what it previews and checks afterwards
 * (`config:plan --deploy`) are one list: `DEPLOY_WRITE_PLAN`. A flag in one place and not the other would make the
 * "anything left?" check lie.
 */
const REPO = path.resolve(import.meta.dirname, "../..");
const DEPLOY = fs.readFileSync(path.join(REPO, "scripts/ops/deploy.sh"), "utf8");

/**
 * The commands the write step runs (`config_write_run pnpm …`), in order, as argument lists after `pnpm`. The plain
 * `config:migrate --write` is only for a target from before the overlay format, which refuses the conversion flag
 * (tests/ops/deploy-script.test.ts): not part of the plan for this version.
 */
const writeStepCommands = (): string[][] =>
  [...DEPLOY.matchAll(/^\s*config_write_run pnpm (config:[^|;&\n]*?)(?= \|\||;|$)/gm)]
    .map((match) => (match[1] ?? "").trim().split(/\s+/))
    .filter((command) => command.join(" ") !== "config:migrate --write");
/** Every `pnpm config:…` the script runs or prints, wherever it is. */
const anyCommands = (script: string): string[][] => [...DEPLOY.matchAll(new RegExp(`pnpm (${script}[^|;&"\\n]*)`, "g"))].map((match) => (match[1] ?? "").trim().split(/\s+/));
const flagsOf = (command: string[]) => command.slice(1).filter((word) => word.startsWith("--"));

describe("the write step of deploy.sh", () => {
  it("runs the four commands in this order", () => {
    expect(writeStepCommands().map((command) => command.join(" "))).toEqual([
      "config:migrate --write --convert-overlays",
      "config:init",
      "config:plan --deploy --check",
      "config:migrate --prune-backups",
    ]);
  });

  it("creates files exactly when the plan includes them", () => {
    const init = writeStepCommands().filter((command) => command[0] === "config:init");
    expect(init.length > 0).toBe(DEPLOY_WRITE_PLAN.init);
    // plain `config:init`: no source directory, and not the .env-only mode
    for (const command of init) expect(flagsOf(command)).toEqual([]);
  });

  it("converts overlays exactly when the plan includes the conversion", () => {
    const converts = writeStepCommands().filter((command) => command[0] === "config:migrate" && command.includes("--write")).map((command) => command.includes("--convert-overlays"));
    expect(converts).toEqual([DEPLOY_WRITE_PLAN.convertOverlays]);
  });

  it("previews and checks the same plan: every config:plan in the script says --deploy", () => {
    const plans = anyCommands("config:plan");
    expect(plans.length).toBeGreaterThanOrEqual(2);
    for (const command of plans) expect(flagsOf(command), command.join(" ")).toContain("--deploy");
    // the check after the write adds --check and changes nothing else
    const check = writeStepCommands().find((command) => command[0] === "config:plan");
    expect(flagsOf(check ?? [])).toEqual(["--deploy", "--check"]);
  });

  it("the preview before the backup writes nothing: no write flag on it", () => {
    for (const command of anyCommands("config:plan")) expect(flagsOf(command)).not.toContain("--write");
  });

  it("the --dry-run listing names the same commands as the real step", () => {
    const listed = [...DEPLOY.matchAll(/^\s*echo "  \\\$ (pnpm config:[^"]*)"/gm)].map((match) => (match[1] ?? "").replace(/^pnpm /, ""));
    expect(listed).toEqual(writeStepCommands().map((command) => command.join(" ")));
  });

  it("passes bash -n", () => {
    expect(() => execFileSync("bash", ["-n", path.join(REPO, "scripts/ops/deploy.sh")])).not.toThrow();
  });
});

describe("DEPLOY_WRITE_PLAN is read by the preview and by doctor only", () => {
  const SOURCES = ["src", "scripts"];
  function usersOf(dir: string): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) found.push(...usersOf(relative));
      else if (/\.(ts|tsx|sh|mjs)$/.test(entry.name) && fs.readFileSync(path.join(REPO, relative), "utf8").includes("DEPLOY_WRITE_PLAN")) found.push(relative);
    }
    return found;
  }

  it("is defined once, exported, and used by `config:plan --deploy` and the doctor probe", () => {
    const users = SOURCES.flatMap(usersOf).sort();
    expect(users).toEqual([
      "scripts/config-plan.ts",
      "src/lib/config/index.ts",
      "src/lib/config/migrations/plan-writes.ts",
      "src/lib/ops/doctor/probes.ts",
    ]);
  });
});

describe("pnpm config:plan", () => {
  let tmp: TempConfig;
  beforeEach(() => { tmp = makeTempConfig({ user: "empty" }); });
  afterEach(() => tmp.cleanup());
  const created = (out: string) => out.split("\n").filter((line) => line.startsWith("+ "));

  it("--deploy lists the writes DEPLOY_WRITE_PLAN lists, one `+` line per file to create", () => {
    const run = runConfigScript(tmp, "config-plan.ts", ["--deploy"]);
    expect(run.status).toBe(0);
    const plan = planConfigWrites(DEPLOY_WRITE_PLAN);
    expect(created(run.out)).toHaveLength(plan.writes.filter((write) => write.kind === "create").length);
    expect(created(run.out).length).toBeGreaterThan(0);
  });

  it("without --deploy it plans migrations only, even when files are missing", () => {
    const run = runConfigScript(tmp, "config-plan.ts");
    expect(run.status).toBe(0);
    expect(created(run.out)).toEqual([]);
    expect(run.out).toContain("no config writes pending");
  });

  it("--check exits 2 while something is planned and 0 once nothing is, and writes nothing itself", () => {
    const before = fs.readdirSync(tmp.configDir);
    expect(runConfigScript(tmp, "config-plan.ts", ["--deploy", "--check"]).status).toBe(2);
    expect(fs.readdirSync(tmp.configDir)).toEqual(before);
    expect(runConfigScript(tmp, "config-init.ts").status).toBe(0);
    const after = runConfigScript(tmp, "config-plan.ts", ["--deploy", "--check"]);
    expect(after.status, after.out).toBe(0);
    expect(after.out).toContain("no config writes pending");
  });

  it("an unknown flag is refused with exit 2", () => {
    expect(runConfigScript(tmp, "config-plan.ts", ["--nope"]).status).toBe(2);
  });
});
