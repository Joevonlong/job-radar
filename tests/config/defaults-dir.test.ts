// @vitest-environment node
import { runConfigScript } from "./run-script";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assertMigrationChain, CONFIG_MIGRATIONS, CONFIG_NAMES, configRegistry, LAYERED_CONFIG_NAMES, parseConfigTextWithVersion, type ConfigName } from "@/lib/config";

import { FIXTURE_DEFAULTS_DIR, makeTempConfig, REPO_DEFAULTS_DIR, type TempConfig } from "./helpers";

/** The file of a config in a defaults directory (profile files: their templates). */
const fileIn = (dir: string, name: ConfigName): string =>
  configRegistry[name].location === "profile" ? path.join(dir, "profile.example", configRegistry[name].file) : path.join(dir, configRegistry[name].file);

describe("the repository's defaults directory: valid and current, whatever it contains", () => {
  it.each(CONFIG_NAMES)("%s passes its schema at the code's config_version", (name) => {
    const file = fileIn(REPO_DEFAULTS_DIR, name);
    const { migration } = parseConfigTextWithVersion(name, fs.readFileSync(file, "utf8"), file);
    expect(migration.applied).toEqual([]);
  });

  it("every registered migration chain runs 1 → 2 → … without gaps", () => {
    for (const [name, steps] of Object.entries(CONFIG_MIGRATIONS)) expect(() => assertMigrationChain(name, steps ?? [])).not.toThrow();
  });

  it("the test fixture snapshot is valid too (tests build their config from it)", () => {
    for (const name of CONFIG_NAMES) {
      const file = fileIn(FIXTURE_DEFAULTS_DIR, name);
      expect(() => parseConfigTextWithVersion(name, fs.readFileSync(file, "utf8"), file), file).not.toThrow();
    }
  });
});

describe("the scraping channels ship switched off (new installs; existing user files are never rewritten)", () => {
  it("sources.yaml: linkedin.guest, indeed, stepstone and linkedin_fetch_description are off", () => {
    const file = fileIn(REPO_DEFAULTS_DIR, "channels");
    const config = parseConfigTextWithVersion("channels", fs.readFileSync(file, "utf8"), file).value;
    expect(config.linkedin.guest.enabled).toBe(false);
    expect(config.sources.indeed.enabled).toBe(false);
    expect(config.sources.stepstone.enabled).toBe(false);
    expect(config.jobspy.linkedin_fetch_description).toBe(false);
  });
});


describe("the config scripts (pnpm config:init / config:migrate / config:check)", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
    fs.rmSync(tmp.configDir, { recursive: true });
  });
  afterEach(() => tmp.cleanup());

  const run = (script: string, ...args: string[]) => runConfigScript(tmp, script, args);

  it("init fills the user and profile directories once; migrate and check then pass", () => {
    const first = run("config-init.ts");
    expect(first.status, first.out).toBe(0);
    expect(first.out).toContain(`+ ${path.join(tmp.configDir, "ai.yaml")}`);
    expect(first.out).toContain(`+ ${path.join(tmp.profileDir, "me.yaml")}  (from the template)`);
    expect(fs.readdirSync(tmp.configDir).sort()).toEqual(LAYERED_CONFIG_NAMES.filter((n) => configRegistry[n].kind === "user").map((n) => configRegistry[n].file).sort());

    const second = run("config-init.ts");
    expect(second.status).toBe(0);
    expect(second.out).toContain("nothing to do: every file is in place");

    const migrate = run("config-migrate.ts", "--write");
    expect(migrate.status, migrate.out).toBe(0);
    expect(migrate.out).toContain("nothing to migrate");

    const check = run("config-check.ts");
    expect(check.status, check.out).toBe(0);
    expect(check.out).toContain(`✓ ${path.join(tmp.configDir, "ai.yaml")} (user)`);
    expect(check.out).toContain(`✓ ${path.join(tmp.defaultsDir, "models.yaml")} (default)`);
    expect(check.out).toContain(`✓ ${path.join(tmp.defaultsDir, "ai.yaml")} (default, not in use)`);
  });

  it("init --from copies the old directory's changes; check lists the override", () => {
    const from = path.join(tmp.root, "live");
    fs.cpSync(tmp.defaultsDir, from, { recursive: true });
    fs.appendFileSync(path.join(from, "pipeline.yaml"), "# tuned\n");
    const init = run("config-init.ts", "--from", from);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain("(differs from the shipped default: now an override)");
    const check = run("config-check.ts");
    expect(check.status, check.out).toBe(0);
    expect(check.out).toContain(`(user override of a shipped file)`);
    expect(check.out).toContain(`! ${path.join(tmp.configDir, "pipeline.yaml")} replaces the shipped pipeline.yaml`);
  });

  it("init --from a missing directory is refused; check fails on a broken default even when overridden", () => {
    expect(run("config-init.ts", "--from", path.join(tmp.root, "nope")).status).toBe(2);
    run("config-init.ts");
    fs.writeFileSync(path.join(tmp.defaultsDir, "notify.yaml"), "push_min_score: [oops\n");
    const check = run("config-check.ts");
    expect(check.status).toBe(1);
    expect(check.out).toContain(`✗ ${path.join(tmp.defaultsDir, "notify.yaml")} (default, not in use)`);
  });

  it("migrate refuses a file from a newer version and writes nothing", () => {
    run("config-init.ts");
    const file = path.join(tmp.configDir, "ui.yaml");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("config_version: 2", "config_version: 7"));
    const before = fs.readFileSync(file, "utf8");
    const migrate = run("config-migrate.ts", "--write");
    expect(migrate.status).toBe(1);
    expect(migrate.out).toContain("newer than this version of Job Radar supports");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});
