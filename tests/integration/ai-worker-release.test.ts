import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { closeDb, createCycle, finishCycle, getControlRequest, getDb, insertControlRequest } from "@/lib/db";

import { FIXTURE_DEFAULTS_DIR } from "../config/helpers";
import { releaseTreeManifest } from "../helpers/release-tree-manifest";

/**
 * The host ai-worker run from a release directory, as the service definition will start it: a throw-away clone of this
 * checkout (git clone --shared) in a temp directory, the release of HEAD built by the real scripts/ops/prepare-release.sh
 * (--offline: the pnpm store already holds every package after the checkout's own install), then
 * `node --import <release guard> --import <tsx loader> src/ai-worker/index.ts` with the release as working directory.
 * Nothing here touches a real checkout or service manager; the worker gets an empty HOME / TMPDIR and a `claude` stub.
 */
const repo = path.resolve(import.meta.dirname, "../..");
// The test preloads are the release's own copies: the guard refuses a preload from outside the release.
const fixtureInRepo = (name: string): string => path.join(repo, "tests/fixtures/release", name);
const claudeFixture = path.join(repo, "tests/fixtures/ai/claude-success-structured.json");
// The transitive dependency of the fail-closed case: cheerio -> cheerio-select -> css-select -> boolbase. Loaded when
// the worker starts (the channels import cheerio), not a direct dependency (so nothing in the release's top-level
// node_modules provides it), and tiny.
const TRANSITIVE = "boolbase";

let base = "";
let main = "";
let release = "";
let guard = "";
let loader = "";
let recordHook = "";
let runtimeStub = "";

const tmpPath = (...parts: string[]): string => path.join(base, ...parts);

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

beforeAll(() => {
  process.env.DATABASE_URL = inject("testDatabaseUrl");
  base = fs.mkdtempSync(path.join(os.tmpdir(), "ai-worker-release-"));
  main = tmpPath("main");
  const sha = git(repo, "rev-parse", "HEAD");
  git(base, "clone", "-q", "--shared", "--no-checkout", repo, main);
  git(main, "checkout", "-q", "--detach", sha);
  for (const dir of ["data/config", "data/profile", "data/logs"]) fs.mkdirSync(path.join(main, dir), { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JOB_RADAR_RELEASES_LOCK_TOKEN;
  const r = spawnSync("bash", [path.join(repo, "scripts/ops/prepare-release.sh"), sha, "--root", main, "--offline"], { encoding: "utf8", env, timeout: 600_000 });
  if (r.status !== 0) throw new Error(`prepare-release.sh failed (${r.status}):\n${r.stderr}`);
  release = r.stdout.trim();
  expect(release).toBe(path.join(main, "data/releases/ai-worker", sha));
  guard = path.join(release, "src/ai-worker/release-guard.mjs");
  loader = path.join(release, "node_modules/tsx/dist/loader.mjs");
  recordHook = path.join(release, "tests/fixtures/release/record-urls.mjs");
  runtimeStub = path.join(release, "tests/fixtures/release/runtime-stub.mjs");
}, 600_000);

afterAll(async () => {
  await closeDb();
  // the release is read-only: directories get u+w back (never following a link), then the temp tree goes
  if (base && path.basename(base).startsWith("ai-worker-release-") && base.startsWith(os.tmpdir())) {
    spawnSync("find", ["-P", base, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/** The worker's environment: nothing of the test machine's HOME, PATH limited to a `claude` stub and the system. */
function workerEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const home = tmpPath("home");
  const bin = tmpPath("bin");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\ncat "${claudeFixture}"\n`, { mode: 0o755 });
  return {
    PATH: [bin, "/usr/bin", "/bin"].join(path.delimiter),
    HOME: home,
    TMPDIR: home,
    // keeps the test database guard on in the worker
    VITEST: process.env.VITEST ?? "true",
    NODE_ENV: "test",
    DATABASE_URL: inject("testDatabaseUrl"),
    DB_CONNECT_TIMEOUT_SECONDS: "30",
    JOB_RADAR_DATA_ROOT: main,
    JOB_RADAR_DEFAULTS_DIR: FIXTURE_DEFAULTS_DIR,
    JOB_RADAR_CONFIG_DIR: path.join(main, "data/config"),
    JOB_RADAR_PROFILE_DIR: path.join(main, "data/profile"),
    ...extra,
  };
}

const workerArgs = (record: string): string[] => ["--import", record, "--import", guard, "--import", loader, "--env-file-if-exists=.env", "src/ai-worker/index.ts", "--log-dir", tmpPath("logs")];

const recorded = (file: string): string[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

/** Runs to completion (the fail-closed cases exit at once). */
function runOnce(args: string[], env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, args, { cwd: release, env, encoding: "utf8", timeout: 120_000 });
  return { status: r.status, stderr: `${r.stderr}${r.stdout}` };
}

describe("the ai-worker from a release directory", () => {
  it("handles a run_ai request; every module it resolves lies inside the release; the release is unchanged afterwards", async () => {
    expect(fs.existsSync(path.join(release, "node_modules/esbuild"))).toBe(false); // esbuild only through tsx
    const before = releaseTreeManifest(release);
    const record = tmpPath("record-run.txt");

    const db = getDb();
    const cycle = await createCycle(db, { kind: "manual" });
    await finishCycle(db, cycle.id, { status: "succeeded", summary: { steps: [] } });
    const request = await insertControlRequest(db, { kind: "run_ai", payload: { cycleId: cycle.id } });

    const child = spawn(process.execPath, workerArgs(recordHook), { cwd: release, env: workerEnv({ RECORD_FILE: record }), stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    const exited = new Promise<number | null>((resolve) => child.on("exit", (code) => resolve(code)));
    try {
      const until = Date.now() + 90_000;
      let status = "pending";
      while (status === "pending" || status === "running") {
        if (child.exitCode !== null) throw new Error(`the worker exited early (${child.exitCode}):\n${output}`);
        if (Date.now() > until) throw new Error(`run_ai did not finish:\n${output}`);
        await new Promise((r) => setTimeout(r, 200));
        status = (await getControlRequest(db, request.id))?.status ?? "missing";
      }
      expect(status).toBe("done");
    } finally {
      if (child.exitCode === null) child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);

    const urls = recorded(record);
    expect(urls.some((u) => u.endsWith("/src/ai-worker/index.ts"))).toBe(true);
    expect(urls.some((u) => u.includes("/node_modules/.pnpm/") && u.includes(`/node_modules/${TRANSITIVE}/`))).toBe(true);
    const realRelease = fs.realpathSync(release);
    const outside = urls
      .filter((u) => u.startsWith("file:"))
      .map((u) => fs.realpathSync(fileURLToPath(u)))
      .filter((p) => p !== realRelease && !p.startsWith(realRelease + path.sep));
    expect(outside).toEqual([]);
    expect(urls.filter((u) => !u.startsWith("file:") && !u.startsWith("node:"))).toEqual([]);
    expect(releaseTreeManifest(release)).toEqual(before);
  }, 180_000);
});

describe("the release guard fails closed", () => {
  // Moves a package directory of the release's .pnpm store aside for one test (the release is read-only: the parent
  // gets u+w for the rename and loses it again), so resolution falls through to <main>/node_modules, where a stand-in
  // writes a marker file if it is ever executed.
  function withPackageOutside(storeDirPrefix: string, pkgName: string, files: Record<string, string>, body: (marker: string) => void): void {
    const pnpmDir = path.join(release, "node_modules/.pnpm");
    const entry = fs.readdirSync(pnpmDir).find((n) => n.startsWith(storeDirPrefix));
    if (!entry) throw new Error(`no ${storeDirPrefix}* in ${pnpmDir}`);
    const from = path.join(pnpmDir, entry);
    const aside = path.join(pnpmDir, `${entry}.aside`);
    const standIn = path.join(main, "node_modules", pkgName);
    const marker = tmpPath(`marker-${pkgName.replace("/", "+")}`);
    fs.mkdirSync(standIn, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(standIn, name)), { recursive: true });
      fs.writeFileSync(path.join(standIn, name), content.replaceAll("MARKER", JSON.stringify(marker)), { mode: 0o755 });
    }
    const mode = fs.statSync(pnpmDir).mode & 0o777;
    fs.chmodSync(pnpmDir, mode | 0o200);
    fs.renameSync(from, aside);
    try {
      body(marker);
    } finally {
      fs.renameSync(aside, from);
      fs.chmodSync(pnpmDir, mode);
      fs.rmSync(path.join(main, "node_modules"), { recursive: true, force: true });
    }
  }

  it(`a transitive dependency (${TRANSITIVE}) that resolves outside the release: exit 1, nothing of it runs`, () => {
    withPackageOutside(`${TRANSITIVE}@`, TRANSITIVE, {
      "package.json": JSON.stringify({ name: TRANSITIVE, version: "1.0.0", main: "index.js" }),
      "index.js": "require('node:fs').writeFileSync(MARKER, 'ran');\nmodule.exports = {};\n",
    }, (marker) => {
      const r = runOnce(workerArgs(recordHook), workerEnv({ RECORD_FILE: tmpPath("record-transitive.txt") }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("release guard:");
      expect(r.stderr).toContain(path.join(main, "node_modules", TRANSITIVE));
      expect(fs.existsSync(marker)).toBe(false);
    });
  }, 120_000);

  it("esbuild's platform package outside the release: refused before tsx loads; ESBUILD_BINARY_PATH outside too", () => {
    const platformPkg = `@esbuild/${process.platform}-${os.arch()}`;
    withPackageOutside(`${platformPkg.replace("/", "+")}@`, platformPkg, {
      "package.json": JSON.stringify({ name: platformPkg, version: "0.0.0" }),
      "bin/esbuild": "#!/bin/sh\nnode -e \"require('node:fs').writeFileSync(process.argv[1], 'ran')\" MARKER\n",
    }, (marker) => {
      const record = tmpPath("record-esbuild.txt");
      const r = runOnce(workerArgs(recordHook), workerEnv({ RECORD_FILE: record }));
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`release guard: ${platformPkg}/package.json (from esbuild) resolved to`);
      expect(fs.existsSync(marker)).toBe(false);
      expect(recorded(record).some((u) => u.includes("tsx/dist/loader.mjs"))).toBe(false);
    });

    const outsideBinary = tmpPath("esbuild-elsewhere");
    fs.writeFileSync(outsideBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const r = runOnce(workerArgs(recordHook), workerEnv({ RECORD_FILE: tmpPath("record-binary.txt"), ESBUILD_BINARY_PATH: outsideBinary }));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("release guard: ESBUILD_BINARY_PATH");
  }, 120_000);
});

describe("the release guard's runtime preconditions (no database)", () => {
  const loadTs = (extraImports: string[], env: Record<string, string>): { status: number | null; stderr: string; urls: string[] } => {
    const record = tmpPath(`record-pre-${Object.values(env).join("-").replace(/[^a-z0-9.-]/gi, "_")}.txt`);
    const r = runOnce(
      ["--import", recordHook, ...extraImports.flatMap((m) => ["--import", m]), "--import", guard, "--import", loader, "--input-type=module", "-e", `await import(${JSON.stringify(path.join(release, "src/lib/config/paths.ts"))})`],
      { ...workerEnv(), RECORD_FILE: record, ...env },
    );
    return { ...r, urls: recorded(record) };
  };

  it("loads a .ts module of the release with the current Node (the baseline of the cases below)", () => {
    const r = loadTs([], {});
    expect(r.stderr).not.toContain("module.register called");
    expect(r.status).toBe(0);
    expect(r.urls.some((u) => u.includes("tsx/dist/loader.mjs"))).toBe(true);
  });

  it.each([["22.22.2"], ["23.0.0"]])("a Node %s outside engines.node: exit 1, before tsx's loader is resolved", (version) => {
    const r = loadTs([runtimeStub], { RUNTIME_STUB: `node=${version}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`release guard: Node ${version} does not satisfy engines.node`);
    expect(r.urls.some((u) => u.includes("tsx/dist/loader.mjs"))).toBe(false);
  });

  it("no module.registerHooks: exit 1", () => {
    const r = loadTs([runtimeStub], { RUNTIME_STUB: "no-register-hooks" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("release guard: module.registerHooks is not available");
  });

  it.each([
    ["require('node:module').register", ["-e", "require('node:module').register('data:text/javascript,')"]],
    ["the ESM named import register", ["--input-type=module", "-e", "import { register } from 'node:module'; register('data:text/javascript,')"]],
  ])("after the guard, %s exits 1 (no hooks thread can start)", (_label, code) => {
    const r = runOnce(["--import", guard, ...code], workerEnv());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("release guard: tsx is not on the synchronous hooks path (module.register called)");
  });
});

describe("the release guard refuses preloads from outside the release (no database)", () => {
  const loadArgs = ["--input-type=module", "-e", "await import('./src/lib/config/paths.ts'); console.log('loaded')"];

  it("a preload in NODE_OPTIONS: exit 1, nothing of the release loaded", () => {
    const outside = tmpPath("outside-preload.cjs");
    fs.writeFileSync(outside, "\n");
    const r = runOnce(["--import", guard, "--import", loader, ...loadArgs], { ...workerEnv(), NODE_OPTIONS: `--require ${outside}` });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`release guard: NODE_OPTIONS holds "--require"`);
    expect(r.stderr).not.toContain("loaded");
  });

  it.each([
    ['a quoted "--import" with a data: URL', '"--import" data:text/javascript,0', '"--import"'],
    ['a quoted "--require" of a built-in', '"--require" node:fs', '"--require"'],
    ["the underscore spelling --experimental_loader", "--experimental_loader=node:fs", '"--experimental_loader=node:fs"'],
    ["an option that is not on the allowlist", "--trace-warnings", '"--trace-warnings"'],
    ["an allowlisted option with a value out of its range", "--max-old-space-size=99999999", '"--max-old-space-size=99999999"'],
  ])("NODE_OPTIONS with %s: exit 1, nothing of the release loaded", (_label, value, shown) => {
    const r = runOnce(["--import", guard, "--import", loader, ...loadArgs], { ...workerEnv(), NODE_OPTIONS: value });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`release guard: NODE_OPTIONS holds ${shown}`);
    expect(r.stderr).not.toContain("loaded");
  });

  it("NODE_OPTIONS with only allowlisted options (either spelling, quoted or not) is accepted", () => {
    const r = runOnce(["--import", guard, "--import", loader, ...loadArgs], {
      ...workerEnv(),
      NODE_OPTIONS: '--max-old-space-size=512 --max_semi_space_size=16 "--enable-source-maps" --no-warnings',
    });
    expect(r.stderr).not.toContain("release guard:");
    expect(r.status).toBe(0);
  });

  it.each([
    ["--loader", (f: string) => ["--loader", f]],
    ["--experimental-loader", (f: string) => [`--experimental-loader=${f}`]],
    ["--experimental_loader (the underscore spelling)", (f: string) => [`--experimental_loader=${f}`]],
    ["--require", (f: string) => ["--require", f]],
    ["-r", (f: string) => ["-r", f]],
  ])("%s on the command line, even with a file inside the release: exit 1 (only --import preloads)", (_label, flags) => {
    const inside = path.join(release, "scripts/ops/check-node-engines.mjs");
    const r = runOnce(["--import", guard, ...flags(inside), "--import", loader, ...loadArgs], workerEnv());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("only --import preloads are allowed");
    expect(r.stderr).not.toContain("loaded");
  });

  it("an --import on the command line whose file lies outside the release (this checkout's copy of a fixture): exit 1", () => {
    const outside = fixtureInRepo("record-urls.mjs");
    const r = runOnce(["--import", guard, "--import", outside, "--import", loader, ...loadArgs], { ...workerEnv(), RECORD_FILE: tmpPath("record-outside.txt") });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`release guard: the preload --import ${outside} resolved to`);
    expect(r.stderr).not.toContain("loaded");
  });

  it.each([["tsx"], ["data:text/javascript,0"]])("--import %s (a package name or URL): exit 1", (value) => {
    const r = runOnce(["--import", guard, `--import=${value}`, "--import", loader, ...loadArgs], workerEnv());
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`release guard: --import ${value}: a preload must be given as a path inside`);
  });

  it("the guard and tsx's loader as relative paths inside the release are accepted", () => {
    const r = runOnce(["--import", "./src/ai-worker/release-guard.mjs", "--import", "./node_modules/tsx/dist/loader.mjs", ...loadArgs], workerEnv());
    expect(r.stderr).not.toContain("release guard:");
    expect(r.status).toBe(0);
  });
});
