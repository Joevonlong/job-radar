import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { planProjects, SERIAL_CHAIN, specFiltersFromArgv } from "../e2e/projects";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIR = path.join(ROOT, "e2e");
const SPECS = fs.readdirSync(TEST_DIR).filter((name) => name.endsWith(".spec.ts")).sort();
const PW = ["node", "/x/node_modules/@playwright/test/cli.js", "test"];

describe("specFiltersFromArgv", () => {
  it("returns the spec filters and skips options and their values", () => {
    expect(specFiltersFromArgv([...PW])).toEqual([]);
    expect(specFiltersFromArgv([...PW, "e2e/list-today.spec.ts"])).toEqual(["e2e/list-today.spec.ts"]);
    expect(specFiltersFromArgv([...PW, "--workers", "2", "--reporter", "list", "--fail-on-flaky-tests", "e2e/a.spec.ts:12", "b"])).toEqual(["e2e/a.spec.ts:12", "b"]);
    expect(specFiltersFromArgv([...PW, "--workers=2", "-g", "seen", "-j", "4", "x.spec.ts"])).toEqual(["x.spec.ts"]);
    // --project takes every word up to the next option
    expect(specFiltersFromArgv([...PW, "--project", "chromium", "chromium-market", "--list"])).toEqual([]);
    // an optional value is taken only when it does not look like a spec
    expect(specFiltersFromArgv([...PW, "-u", "e2e/a.spec.ts"])).toEqual(["e2e/a.spec.ts"]);
    expect(specFiltersFromArgv([...PW, "--update-snapshots", "all", "e2e/a.spec.ts"])).toEqual(["e2e/a.spec.ts"]);
  });

  it("is empty for any other process (a Playwright worker, vitest)", () => {
    expect(specFiltersFromArgv(["node", "/x/playwright/lib/common/process.js"])).toEqual([]);
    expect(specFiltersFromArgv(["node", "/x/vitest.mjs", "run", "test"])).toEqual([]);
  });
});

describe("planProjects", () => {
  it("a full run: parallel, then exclusive (one worker), then the serial chain, each after the one before", () => {
    const plan = planProjects(SPECS, TEST_DIR, []);
    expect(plan.map((p) => p.name)).toEqual(["chromium", "chromium-exclusive", ...SERIAL_CHAIN.map((e) => e.name)]);
    expect(plan[0]!.dependencies).toEqual([]);
    expect(plan[1]).toMatchObject({ workers: 1, dependencies: ["chromium"] });
    for (let i = 2; i < plan.length; i += 1) expect(plan[i]!.dependencies).toEqual([plan[i - 1]!.name]);
  });

  it("every chain spec exists, and the parallel projects never pick one up", () => {
    for (const entry of SERIAL_CHAIN) expect(SPECS).toContain(entry.spec);
    const [parallel] = planProjects(SPECS, TEST_DIR, []);
    for (const entry of SERIAL_CHAIN) expect(parallel!.testIgnore!.test(path.join(TEST_DIR, entry.spec))).toBe(true);
    expect(parallel!.testIgnore!.test(path.join(TEST_DIR, "dashboard.spec.ts"))).toBe(false);
  });

  it("named spec files: only their projects, narrowed to them, chained in suite order, nothing else as a dependency", () => {
    const one = planProjects(SPECS, TEST_DIR, ["e2e/settings.spec.ts"]);
    expect(one.map((p) => [p.name, p.dependencies])).toEqual([["chromium-config-settings", []]]);

    const parallelOnly = planProjects(SPECS, TEST_DIR, ["e2e/dashboard.spec.ts"]);
    expect(parallelOnly.map((p) => [p.name, p.dependencies])).toEqual([
      ["chromium", []],
      ["chromium-exclusive", ["chromium"]],
    ]);
    // the dependency runs in full, so it is narrowed to the named file
    expect(parallelOnly[0]!.testMatch!.test(path.join(TEST_DIR, "dashboard.spec.ts"))).toBe(true);
    expect(parallelOnly[0]!.testMatch!.test(path.join(TEST_DIR, "filter.spec.ts"))).toBe(false);

    const mixed = planProjects(SPECS, TEST_DIR, ["e2e/market.spec.ts", "list-today"]);
    expect(mixed.map((p) => [p.name, p.dependencies])).toEqual([
      ["chromium", []],
      ["chromium-exclusive", ["chromium"]],
      ["chromium-market", ["chromium-exclusive"]],
    ]);
  });

  it("a filter with a line number: no chaining, so a dependency never runs its whole file", () => {
    const plan = planProjects(SPECS, TEST_DIR, ["e2e/dashboard.spec.ts:206"]);
    expect(plan.every((p) => p.dependencies.length === 0)).toBe(true);
  });
});

describe("playwright test --list (the real config)", () => {
  const list = (...args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.E2E_SPEC_FILTERS;
    // the list reporter only (the config adds an HTML report under CI=true, which would land in the checkout), output in a temp dir
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-projects-list-"));
    const out = spawnSync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=list", `--output=${output}`, ...args], { cwd: ROOT, env, encoding: "utf8" });
    fs.rmSync(output, { recursive: true, force: true });
    expect(out.status, out.stderr).toBe(0);
    return out.stdout;
  };
  const total = (stdout: string) => /Total: (\d+) tests? in (\d+) files?/.exec(stdout)?.slice(1).map(Number);

  it("one serial-chain spec lists only its own tests", () => {
    const out = list("e2e/market.spec.ts");
    expect(total(out)?.[1]).toBe(1);
    expect(out).not.toMatch(/\[chromium\] /);
  });

  it("one parallel spec lists only its own file", () => {
    expect(total(list("e2e/filter.spec.ts"))?.[1]).toBe(1);
  });

  it("the whole suite lists every spec file", () => {
    expect(total(list())?.[1]).toBe(SPECS.length);
  });
}, 60_000);
