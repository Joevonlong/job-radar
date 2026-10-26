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

  it("the parallel part keeps only the parallel and exclusive projects and their dependency", () => {
    expect(planProjects(SPECS, TEST_DIR, [], "parallel")).toEqual(planProjects(SPECS, TEST_DIR, []).slice(0, 2));
  });

  it("the chain part starts without dependencies and keeps every subsequent link serial", () => {
    const plan = planProjects(SPECS, TEST_DIR, [], "chain");
    expect(plan.map((p) => p.name)).toEqual(SERIAL_CHAIN.map((e) => e.name));
    expect(plan[0]!.dependencies).toEqual([]);
    for (let i = 1; i < plan.length; i += 1) expect(plan[i]!.dependencies).toEqual([plan[i - 1]!.name]);
    expect(plan).toEqual(planProjects(SPECS, TEST_DIR, []).slice(2).map((p, i) => i === 0 ? { ...p, dependencies: [] } : p));
  });

  it("the two parts cover exactly the full suite's specs without overlap", () => {
    const coverage = (part?: string) => SPECS.filter((spec) => planProjects(SPECS, TEST_DIR, [], part).some((p) => {
      const file = path.join(TEST_DIR, spec);
      return (!p.testMatch || p.testMatch.test(file)) && !p.testIgnore?.test(file);
    }));
    const parallel = coverage("parallel");
    const chain = coverage("chain");
    expect(parallel.length).toBeGreaterThan(0);
    expect(chain.length).toBe(SERIAL_CHAIN.length);
    expect(parallel.filter((spec) => chain.includes(spec))).toEqual([]);
    expect([...parallel, ...chain].sort()).toEqual(coverage());
  });

  it.each(["", "full", "Parallel", "both"])("rejects invalid part %j", (part) => {
    expect(() => planProjects(SPECS, TEST_DIR, [], part)).toThrow(/E2E_PART.*parallel.*chain/);
    expect(() => planProjects(SPECS, TEST_DIR, ["e2e/market.spec.ts"], part)).toThrow(/E2E_PART/);
  });

  it("an unset part preserves the full and filtered plans", () => {
    for (const filters of [[], ["e2e/settings.spec.ts", "list-today"], ["e2e/dashboard.spec.ts:206"]]) {
      expect(planProjects(SPECS, TEST_DIR, filters, undefined)).toEqual(planProjects(SPECS, TEST_DIR, filters));
    }
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

  it("named specs stay narrowed and chained within their selected part", () => {
    const filters = ["e2e/settings.spec.ts", "e2e/market.spec.ts", "list-today"];
    const parallel = planProjects(SPECS, TEST_DIR, filters, "parallel");
    expect(parallel.map((p) => [p.name, p.dependencies])).toEqual([
      ["chromium", []],
      ["chromium-exclusive", ["chromium"]],
    ]);
    for (const p of parallel) {
      expect(p.testMatch!.test(path.join(TEST_DIR, "list-today.spec.ts"))).toBe(true);
      expect(p.testMatch!.test(path.join(TEST_DIR, "dashboard.spec.ts"))).toBe(false);
      expect(p.testMatch!.test(path.join(TEST_DIR, "settings.spec.ts"))).toBe(false);
    }
    const chain = planProjects(SPECS, TEST_DIR, filters, "chain");
    expect(chain.map((p) => [p.name, p.dependencies])).toEqual([
      ["chromium-config-settings", []],
      ["chromium-market", ["chromium-config-settings"]],
    ]);
    expect(chain[0]!.testMatch!.test(path.join(TEST_DIR, "settings.spec.ts"))).toBe(true);
    expect(chain[0]!.testMatch!.test(path.join(TEST_DIR, "market.spec.ts"))).toBe(false);
    expect(chain[1]!.testMatch!.test(path.join(TEST_DIR, "market.spec.ts"))).toBe(true);
    expect(planProjects(SPECS, TEST_DIR, ["e2e/market.spec.ts"], "parallel")).toEqual([]);
    expect(planProjects(SPECS, TEST_DIR, ["list-today"], "chain")).toEqual([]);
  });

  it.each(["parallel", "chain"])("line filters still disable dependencies within the %s part", (part) => {
    const plan = planProjects(SPECS, TEST_DIR, ["e2e/dashboard.spec.ts:206", "e2e/settings.spec.ts:12", "e2e/market.spec.ts:12"], part);
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.dependencies.length === 0)).toBe(true);
  });
});

describe("playwright test --list (the real config)", () => {
  const list = (part: string | undefined, ...args: string[]) => {
    // Listing never starts a server; use an unreachable dummy address instead of inheriting a database setting.
    const env: NodeJS.ProcessEnv = { ...process.env, E2E_ADMIN_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:1/postgres" };
    delete env.E2E_SPEC_FILTERS;
    delete env.E2E_PART;
    if (part !== undefined) env.E2E_PART = part;
    // the list reporter only (the config adds an HTML report under CI=true, which would land in the checkout), output in a temp dir
    const output = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-projects-list-"));
    const out = spawnSync("pnpm", ["exec", "playwright", "test", "--list", "--reporter=list", `--output=${output}`, ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 30_000 });
    fs.rmSync(output, { recursive: true, force: true });
    expect(out.status, out.stderr).toBe(0);
    return out.stdout;
  };
  const total = (stdout: string) => /Total: (\d+) tests? in (\d+) files?/.exec(stdout)?.slice(1).map(Number);
  const identities = (stdout: string) => stdout.split("\n").filter((line) => /^\s+\[[^\]]+\] › /.test(line)).map((line) => line.trim()).sort();

  it("one serial-chain spec lists only its own tests", () => {
    const out = list(undefined, "e2e/market.spec.ts");
    expect(total(out)?.[1]).toBe(1);
    expect(out).not.toMatch(/\[chromium\] /);
  });

  it("one parallel spec lists only its own file", () => {
    expect(total(list(undefined, "e2e/filter.spec.ts"))?.[1]).toBe(1);
  });

  it("the whole suite lists every spec file", () => {
    expect(total(list(undefined))?.[1]).toBe(SPECS.length);
  });

  it("the two parts list exactly the full suite's test identities without overlap", () => {
    const full = list(undefined);
    const parallel = identities(list("parallel"));
    const chain = identities(list("chain"));
    expect(parallel.length).toBeGreaterThan(0);
    expect(chain.length).toBeGreaterThan(0);
    expect(parallel.filter((test) => chain.includes(test))).toEqual([]);
    expect([...parallel, ...chain].sort()).toEqual(identities(full));
    expect(parallel.length + chain.length).toBe(total(full)?.[0]);
  });

  it.each(["parallel", "chain"])("mixed spec filters list only the %s part's matching tests", (part) => {
    const out = list(part, "e2e/filter.spec.ts", "e2e/market.spec.ts");
    expect(total(out)?.[1]).toBe(1);
    expect(out).toContain(part === "parallel" ? "filter.spec.ts:" : "market.spec.ts:");
    expect(out).not.toContain(part === "parallel" ? "market.spec.ts:" : "filter.spec.ts:");
  });
}, 60_000);
