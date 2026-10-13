// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/ops/prepare-release.sh against a throw-away checkout in a temp directory (never a real one). `pnpm` and `tar`
 * on PATH are stubs: the pnpm stub answers --version, logs `install` with its arguments, writes the few files the script
 * checks (node_modules/tsx/dist/loader.mjs, one file under node_modules/.pnpm) and can fail, block (the shared
 * blocking stub), add an in-flight record or create the release path while it runs.
 */
const repo = path.resolve(import.meta.dirname, "../..");
const script = path.join(repo, "scripts/ops/prepare-release.sh");
const blockingStub = path.join(repo, "tests/fixtures/ops/blocking-stub.sh");
const releasesSh = path.join(repo, "scripts/ops/lib/releases.sh");
const ownerFixture = fs.readFileSync(path.join(repo, "tests/fixtures/ops/lock-owner-wrapper.txt"), "utf8");
const STUB_PNPM = "9.8.7"; // the stub's version; the fixture package.json asks for the same one
const realTar = spawnSync("/bin/bash", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();

let base = "";
let main = "";
let bin = "";
let log = "";
let sha = "";

const rdir = (): string => path.join(main, "data/releases/ai-worker");
const lockDir = (): string => path.join(rdir(), ".lock");
const dest = (): string => path.join(rdir(), sha);
const entries = (): string[] => (fs.existsSync(rdir()) ? fs.readdirSync(rdir()).sort() : []);
const leftovers = (): string[] => entries().filter((n) => n.startsWith(".tmp-") || n.startsWith(".trash-"));
const logLines = (): string[] => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
const installs = (): string[] => logLines().filter((l) => l.startsWith("pnpm install"));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function git(...args: string[]): string {
  const r = spawnSync("git", ["-C", main, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
}

function commitFixture(pkg: Record<string, unknown>, message: string): string {
  write(path.join(main, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-release-"));
  main = path.join(base, "main");
  bin = path.join(base, "bin");
  log = path.join(base, "calls.log");
  fs.mkdirSync(main);
  git("init", "-q");
  write(path.join(main, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  write(path.join(main, "src/a.ts"), "export const a = 1;\n");
  write(path.join(main, "src/nested/b.txt"), "b\n");
  write(path.join(main, "scripts/run.sh"), "#!/usr/bin/env bash\necho run\n", 0o755);
  write(path.join(main, ".gitignore"), "data/\n");
  sha = commitFixture({ name: "fixture", packageManager: `pnpm@${STUB_PNPM}`, dependencies: { tsx: "^4.0.0" } }, "init");

  write(
    path.join(bin, "pnpm"),
    `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "--version" ]]; then echo "\${STUB_PNPM_VERSION}"; exit 0; fi
echo "pnpm $* cwd=$PWD" >> "$STUB_LOG"
[[ "\${1:-}" == install ]] || exit 0
if [[ -n "\${STUB_EXTRA_RECORD:-}" ]]; then printf 'script=other\\npid=1\\nstarted=1\\n' > "$STUB_EXTRA_RECORD"; fi
if [[ -n "\${STUB_CREATE:-}" ]]; then mkdir -p "$STUB_CREATE"; fi
mkdir -p node_modules/tsx/dist node_modules/.pnpm/dep
[[ -n "\${STUB_NO_LOADER:-}" ]] || echo 'export {};' > node_modules/tsx/dist/loader.mjs
echo shared > node_modules/.pnpm/dep/file.js; chmod 644 node_modules/.pnpm/dep/file.js
if [[ -n "\${BLOCK_CONTINUE:-}" ]]; then exec bash "$BLOCKING_STUB"; fi
exit "\${STUB_INSTALL_EXIT:-0}"
`,
    0o755,
  );
  write(path.join(bin, "tar"), `#!/usr/bin/env bash\nif [[ -n "\${STUB_TAR_FAIL:-}" ]]; then echo "tar: stub failure" >&2; exit 2; fi\nexec "${realTar}" "$@"\n`, 0o755);
});

afterEach(() => {
  // the releases are read-only: give the directories u+w back (never following a link), then remove the temp tree
  if (base && path.basename(base).startsWith("prepare-release-") && base.startsWith(os.tmpdir())) {
    spawnSync("find", ["-P", base, "-type", "d", "-exec", "chmod", "u+w", "{}", "+"]);
    fs.rmSync(base, { recursive: true, force: true });
  }
  base = "";
});

function scriptEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.JOB_RADAR_RELEASES_LOCK_TOKEN;
  delete env.XDG_CONFIG_HOME;
  return {
    ...env,
    // the ai-worker identity rules read service definitions under HOME: a temp one, never the machine's
    HOME: path.join(base, "home"),
    JOB_RADAR_SERVICE_MANAGER: "launchd",
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    STUB_LOG: log,
    STUB_PNPM_VERSION: STUB_PNPM,
    DEPLOY_TEST_LOG: log,
    BLOCKING_STUB: blockingStub,
    BLOCK_NAME: "install",
    BLOCK_LOCK: lockDir(),
    ...extra,
  };
}

interface Run {
  status: number | null;
  stdout: string;
  stderr: string;
}

function prepare(args: string[] = [], env: Record<string, string> = {}, scriptPath = script): Run {
  const r = spawnSync("bash", [scriptPath, ...(args.length ? args : [sha, "--root", main])], { encoding: "utf8", env: scriptEnv(env), timeout: 60_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// A bash snippet with releases.sh sourced (MAIN, SHA, SCRIPT set), as a calling deploy script would hold the lock.
function caller(snippet: string, env: Record<string, string> = {}): Run {
  const r = spawnSync("/bin/bash", ["-c", `set -u; source "${releasesSh}"; MAIN="${main}"; SHA="${sha}"; SCRIPT="${script}"; ${snippet}`], {
    encoding: "utf8",
    env: scriptEnv(env),
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

// prepare in its own process group (spawn detached), so a test can signal the group like a terminal does.
function startPrepare(env: Record<string, string>): { pid: number; done: Promise<Run> } {
  const child = spawn("bash", [script, sha, "--root", main], { env: scriptEnv(env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const done = new Promise<Run>((resolve) => child.on("close", (code, signal) => resolve({ status: code ?? (signal ? -1 : null), stdout, stderr })));
  return { pid: child.pid ?? -1, done };
}

async function waitFor(what: string, cond: () => boolean, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const archivedFiles = (commit = sha): string[] => git("ls-tree", "-r", "--name-only", commit).split("\n").filter(Boolean).sort();

function filesUnder(dir: string, skip: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const name of fs.readdirSync(path.join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip(r)) continue;
      const st = fs.lstatSync(path.join(dir, r));
      if (st.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk("");
  return out.sort();
}

function dirsUnder(dir: string): string[] {
  const out = [dir];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.lstatSync(p).isDirectory()) out.push(...dirsUnder(p));
  }
  return out;
}

const mode = (p: string): number => fs.lstatSync(p).mode & 0o777;

function corruptMarker(): void {
  fs.chmodSync(dest(), 0o755);
  fs.chmodSync(path.join(dest(), ".release.json"), 0o644);
  fs.writeFileSync(path.join(dest(), ".release.json"), '{\n  "sha": "broken"\n}\n');
}

describe("scripts/ops/prepare-release.sh: building a release", () => {
  it("passes bash -n", () => {
    expect(spawnSync("bash", ["-n", script]).status).toBe(0);
  });

  it("builds the release: exactly the files of git archive, read-only, node_modules modes kept, the path as the only stdout line", () => {
    const r = prepare();
    expect(r.stderr).toContain("ready:");
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${dest()}\n`);

    // the archived files, byte for byte; besides them only node_modules/ and .release.json
    const got = filesUnder(dest(), (rel) => rel === "node_modules" || rel === ".release.json");
    expect(got).toEqual(archivedFiles());
    for (const f of got) {
      const blob = spawnSync("git", ["-C", main, "show", `${sha}:${f}`]).stdout as Buffer;
      expect(fs.readFileSync(path.join(dest(), f)).equals(blob)).toBe(true);
    }

    // read-only: every archived file, the marker, every directory (node_modules included); the executable bit stays
    for (const f of [...got, ".release.json"]) expect(mode(path.join(dest(), f)) & 0o222).toBe(0);
    for (const d of dirsUnder(dest())) expect(mode(d) & 0o222).toBe(0);
    expect(mode(path.join(dest(), "scripts/run.sh")) & 0o111).not.toBe(0);
    // files under node_modules keep their mode (they may be hard links into the pnpm store)
    expect(mode(path.join(dest(), "node_modules/.pnpm/dep/file.js"))).toBe(0o644);

    // the marker: one key per line, the values the release checks
    const markerText = fs.readFileSync(path.join(dest(), ".release.json"), "utf8");
    expect(markerText.split("\n").filter((l) => l.includes(":"))).toHaveLength(5);
    const marker = JSON.parse(markerText) as Record<string, unknown>;
    expect(marker).toEqual({
      sha,
      tree: git("rev-parse", `${sha}^{tree}`),
      lockfile_sha256: sha256(path.join(main, "pnpm-lock.yaml")),
      prod_only: true,
      created: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
    });

    // the install ran in the .tmp directory, production only, from the store, without lifecycle scripts
    expect(installs()).toHaveLength(1);
    expect(installs()[0]).toMatch(new RegExp(`^pnpm install --frozen-lockfile --prod --prefer-offline --ignore-scripts cwd=.*/\\.tmp-${sha}-\\d+$`));
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it("--offline installs with --offline; a trailing slash on --root is the same checkout", () => {
    const r = prepare([sha, "--root", `${main}/`, "--offline"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${dest()}\n`);
    expect(installs()[0]).toContain("pnpm install --frozen-lockfile --prod --offline --ignore-scripts");
  });

  it("a commit without tsx in its dependencies (an older one) gets the full install, and prod_only false", () => {
    sha = commitFixture({ name: "fixture", packageManager: `pnpm@${STUB_PNPM}`, devDependencies: { tsx: "^4.0.0" } }, "older layout");
    const r = prepare();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("full install");
    expect(installs()[0]).toMatch(/^pnpm install --frozen-lockfile --prefer-offline --ignore-scripts cwd=/);
    expect(JSON.parse(fs.readFileSync(path.join(dest(), ".release.json"), "utf8"))).toMatchObject({ prod_only: false });
  });

  it.each([
    [["--root", "/x"], "40 lowercase hex"],
    [["ABC", "--root", "/x"], "40 lowercase hex"],
    [["SHA"], "--root <main> is required"],
    [["SHA", "--root", "relative/path"], "absolute path"],
    [["SHA", "--root", "/"], "absolute path"],
    [["SHA", "--root", "MAIN", "--bogus"], "unknown argument"],
    [["SHA", "SHA", "--root", "MAIN"], "only one commit"],
    [["f".repeat(40), "--root", "MAIN"], "is not a commit"],
  ])("refuses bad arguments %j (exit 1, nothing created)", (args, message) => {
    const r = prepare(args.map((a) => (a === "SHA" ? sha : a === "MAIN" ? main : a)));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
    expect(fs.existsSync(path.join(main, "data"))).toBe(false);
  });

  it("--help prints the usage and exits 0", () => {
    const r = prepare(["--help"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("--root <main>");
    expect(r.stdout).toContain("--offline");
  });
});

describe("scripts/ops/prepare-release.sh: reuse and rebuild", () => {
  it("reuses a release with a valid marker: no install, the same path on stdout, the directory untouched", () => {
    expect(prepare().status).toBe(0);
    const before = fs.readFileSync(path.join(dest(), ".release.json"), "utf8");
    const r = prepare();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${dest()}\n`);
    expect(r.stderr).toContain("reusing");
    expect(installs()).toHaveLength(1);
    expect(fs.readFileSync(path.join(dest(), ".release.json"), "utf8")).toBe(before);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it("rebuilds a release whose marker is invalid (the install script cannot name the installed release): moved aside, removed, built again", () => {
    expect(prepare().status).toBe(0);
    corruptMarker();
    const r = prepare();
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("rebuilding");
    expect(installs()).toHaveLength(2);
    expect(JSON.parse(fs.readFileSync(path.join(dest(), ".release.json"), "utf8"))).toMatchObject({ sha });
    expect(leftovers()).toEqual([]);
  });

  // a copy of the scripts next to a stub install script; `printRelease` false: one that does not know --print-release
  function opsCopy(printRelease = true): string {
    const ops = path.join(base, "ops");
    fs.mkdirSync(path.join(ops, "lib"), { recursive: true });
    fs.copyFileSync(script, path.join(ops, "prepare-release.sh"));
    for (const lib of ["proc.sh", "releases.sh", "ai-worker.sh"]) fs.copyFileSync(path.join(repo, "scripts/ops/lib", lib), path.join(ops, "lib", lib));
    const stub = printRelease
      ? `#!/usr/bin/env bash
echo "install $*" >> "$STUB_LOG"
if [[ -n "\${STUB_TRASH:-}" ]]; then
  # the in-flight record of the running prepare is named by its PID
  for p in $(ls "$BLOCK_LOCK/inflight"); do mkdir -p "$STUB_TRASH-$p/stale" && chmod a-w "$STUB_TRASH-$p"; done
fi
[[ "$1" == --print-release ]] && { printf '%s' "\${STUB_INUSE:-}"; exit "\${STUB_PRINT_EXIT:-0}"; }
exit 1
`
      : `#!/usr/bin/env bash\necho "install $*" >> "$STUB_LOG"\necho "unknown argument: $1" >&2\nexit 1\n`;
    write(path.join(ops, "install-ai-worker.sh"), stub, 0o755);
    return path.join(ops, "prepare-release.sh");
  }
  const askedInstall = (): string[] => logLines().filter((l) => l.startsWith("install "));

  it("refuses to replace an invalid release the installed worker runs from (install-ai-worker.sh --print-release names it)", () => {
    const copy = opsCopy();
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    const r = prepare([], { STUB_INUSE: dest() }, copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("the installed ai-worker runs from it");
    expect(fs.readFileSync(path.join(dest(), ".release.json"), "utf8")).toContain("broken");
    expect(installs()).toHaveLength(1);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(lockDir())).toBe(false);
    expect(askedInstall()).toEqual([`install --print-release --root ${main}`]);

    // another release in use: this one is rebuilt
    const other = prepare([], { STUB_INUSE: path.join(rdir(), "b".repeat(40)) }, copy);
    expect(other.status).toBe(0);
    expect(installs()).toHaveLength(2);
  });

  it.each([
    ["3 (not installed, or only under the legacy label)", "3"],
    ["4 (installed, not from a release directory)", "4"],
  ])("rebuilds an invalid release when --print-release exits %s", (_label, code) => {
    const copy = opsCopy();
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    const r = prepare([], { STUB_PRINT_EXIT: code, STUB_INUSE: code === "4" ? "/somewhere/else" : "" }, copy);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("rebuilding");
    expect(installs()).toHaveLength(2);
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["1 (ambiguous identity or a read failure)", "1", ""],
    ["2 (not a code it defines)", "2", ""],
    ["127", "127", ""],
    ["0 with no path", "0", ""],
    ["0 with a relative path", "0", "data/releases/ai-worker/x"],
  ])("keeps an invalid release and exits 1 when --print-release exits %s (it cannot tell)", (_label, code, out) => {
    const copy = opsCopy();
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    const r = prepare([], { STUB_PRINT_EXIT: code, STUB_INUSE: out }, copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot tell which release the installed ai-worker runs from");
    expect(r.stderr).toContain("may run from it; left in place");
    expect(fs.readFileSync(path.join(dest(), ".release.json"), "utf8")).toContain("broken");
    expect(installs()).toHaveLength(1);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it("an install script that does not know --print-release (no release directories yet): not asked, the invalid release is rebuilt", () => {
    const copy = opsCopy(false);
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    const r = prepare([], {}, copy);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("rebuilding");
    expect(askedInstall()).toEqual([]);
    expect(installs()).toHaveLength(2);
  });

  it("a missing install script: it cannot tell, so the invalid release is kept (exit 1)", () => {
    const copy = opsCopy();
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    fs.rmSync(path.join(base, "ops/install-ai-worker.sh"));
    const r = prepare([], {}, copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("install-ai-worker.sh is missing");
    expect(installs()).toHaveLength(1);
  });

  const installed = (label: string, body: string): string => {
    const file = path.join(base, "home/Library/LaunchAgents", `${label}.plist`);
    write(file, body);
    return file;
  };

  const plistXml = (workdir: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n  <key>ProgramArguments</key>\n  <array><string>/usr/bin/node</string></array>\n  <key>WorkingDirectory</key>\n  <string>${workdir}</string>\n</dict>\n</plist>\n`;
  const unitFile = (body: string): string => {
    const file = path.join(base, "home/.config/systemd/user/job-radar-ai-worker.service");
    write(file, body);
    return file;
  };
  // an old install script; the definition in force decides (decoded, never the raw bytes)
  function preOption(env: Record<string, string> = {}): Run {
    const copy = opsCopy(false);
    expect(prepare([], env, copy).status).toBe(0);
    corruptMarker();
    return prepare([], env, copy);
  }
  const expectKept = (r: Run, message: string): void => {
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(askedInstall()).toEqual([]);
    expect(fs.readFileSync(path.join(dest(), ".release.json"), "utf8")).toContain("broken");
    expect(installs()).toHaveLength(1);
  };
  const expectRebuilt = (r: Run): void => {
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("rebuilding");
    expect(installs()).toHaveLength(2);
  };
  const inRelease = (): string => path.join(rdir(), "c".repeat(40));
  const darwin = process.platform === "darwin";

  describe.runIf(darwin)("an install script without --print-release, launchd (plutil decodes the plist)", () => {
    it("a plist whose working directory is a release directory: kept (exit 1)", () => {
      installed("io.jobradar.ai-worker", plistXml(inRelease()));
      expectKept(preOption(), "names a release directory");
    });

    it("the same as a binary plist with a non-ASCII path (stored as UTF-16, so the raw bytes never spell it): kept", () => {
      const file = installed("io.jobradar.ai-worker", plistXml(path.join(base, "jö", "data/releases/ai-worker", "c".repeat(40))));
      expect(spawnSync("plutil", ["-convert", "binary1", file]).status).toBe(0);
      expect(fs.readFileSync(file).includes("data/releases/ai-worker/")).toBe(false);
      expectKept(preOption(), "names a release directory");
    });

    it("the same in XML with character references for the slashes: kept", () => {
      const file = installed("io.jobradar.ai-worker", plistXml(inRelease().replace("data/releases/ai-worker/", "data&#x2F;releases&#47;ai-worker&#x2f;")));
      expect(fs.readFileSync(file, "utf8")).not.toContain("data/releases/ai-worker/");
      expectKept(preOption(), "names a release directory");
    });

    it("a plist that runs from a checkout: rebuilt", () => {
      installed("io.jobradar.ai-worker", plistXml(main));
      expectRebuilt(preOption());
    });
  });

  it("an install script without --print-release and a launchd definition that cannot be decoded: kept (exit 1)", () => {
    installed("io.jobradar.ai-worker", "not a property list\n");
    expectKept(preOption(), "cannot read or decode");
  });

  describe("an install script without --print-release, systemd (the unit's escapes decoded)", () => {
    const env = { JOB_RADAR_SERVICE_MANAGER: "systemd" };
    const unit = (workdir: string, exec: string): string =>
      `[Service]\n# a comment that names data/releases/ai-worker/ does not count\nWorkingDirectory=${workdir}\nExecStart=${exec}\nEnvironment="PATH=/usr/bin"\n`;

    it("a unit that runs from a checkout (escaped as the install script writes it): rebuilt", () => {
      unitFile(unit(main, '"/usr/bin/node" --import "/x/100%% done/loader.mjs" src/ai-worker/index.ts --log-dir "/l/a\\"b$$c"'));
      expectRebuilt(preOption(env));
    });

    it.each([
      ["WorkingDirectory= in a release directory", () => unit(inRelease(), '"/usr/bin/node" src/ai-worker/index.ts')],
      ["ExecStart= importing from a release directory, with quotes splitting the path", () => unit(main, `"/usr/bin/node" --import "${inRelease().replace("releases/", 'rel""eases/')}/x.mjs"`)],
      ["WorkingDirectory= in a release directory with an escaped %", () => unit(`${inRelease()}/100%%`, '"/usr/bin/node"')],
    ])("%s: kept (exit 1)", (_label, body) => {
      unitFile(body());
      expectKept(preOption(env), "names a release directory");
    });

    it.each([
      ["a C escape in ExecStart=", () => unit(main, `"/usr/bin/node" --import "${inRelease().replaceAll("/", "\\x2f")}/x.mjs"`)],
      ["a specifier in ExecStart=", () => unit(main, '"%h/node" src/ai-worker/index.ts')],
      ["a variable in ExecStart=", () => unit(main, '"/usr/bin/node" --import "$RELEASE/x.mjs"')],
      ["a backslash in WorkingDirectory=", () => unit(`${main}\\x2f`, '"/usr/bin/node"')],
      ["a continued line", () => `[Service]\nWorkingDirectory=${main}\nExecStart="/usr/bin/node" \\\n  src/ai-worker/index.ts\n`],
    ])("%s (cannot be decoded): kept (exit 1)", (_label, body) => {
      unitFile(body());
      expectKept(preOption(env), "cannot read or decode");
    });
  });

  it.each([
    ["an ambiguous identity (two definitions)", () => (installed("io.jobradar.ai-worker", "<plist/>\n"), installed("de.jobradar.ai-worker", "<plist/>\n")), "identity is ambiguous"],
    ["an unreadable definition", () => fs.chmodSync(installed("io.jobradar.ai-worker", "<plist/>\n"), 0o000), "cannot read"],
  ])("an install script without --print-release and %s: kept (exit 1)", (_label, setup, message) => {
    if (process.getuid?.() === 0) return; // root reads anything
    const copy = opsCopy(false);
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    setup();
    const r = prepare([], {}, copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(installs()).toHaveLength(1);
  });

  it.each([
    ["a symbolic link (to a script that knows --print-release)", (file: string) => {
      fs.renameSync(file, `${file}.real`);
      fs.symlinkSync(`${file}.real`, file);
    }, "a symbolic link or not a regular file"],
    ["a directory", (file: string) => {
      fs.rmSync(file);
      fs.mkdirSync(file);
    }, "a symbolic link or not a regular file"],
    ["unreadable", (file: string) => fs.chmodSync(file, 0o000), "cannot read"],
  ])("an install script that is %s: it cannot tell, the invalid release is kept (exit 1)", (_label, change, message) => {
    if (process.getuid?.() === 0) return; // root reads anything
    const copy = opsCopy();
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    change(path.join(base, "ops/install-ai-worker.sh"));
    const r = prepare([], { STUB_PRINT_EXIT: "3" }, copy);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(askedInstall()).toEqual([]);
    expect(installs()).toHaveLength(1);
  });

  it("removes a stale .trash directory of the same name (a reused PID) before moving the invalid release aside", () => {
    const copy = opsCopy();
    expect(prepare([], {}, copy).status).toBe(0);
    corruptMarker();
    const r = prepare([], { STUB_PRINT_EXIT: "3", STUB_TRASH: path.join(rdir(), `.trash-${sha}`) }, copy);
    expect(askedInstall()).toHaveLength(1);
    // read-only, as a killed run leaves it: a plain mv onto it would fail
    expect(r.stderr).not.toContain("could not move");
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(dest(), "stale"))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it("refuses a symbolic link at the release path, and leaves the link and its target alone", () => {
    const elsewhere = path.join(base, "elsewhere");
    write(path.join(elsewhere, "keep.txt"), "keep\n");
    fs.mkdirSync(rdir(), { recursive: true });
    fs.symlinkSync(elsewhere, dest());
    const r = prepare();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("symbolic link");
    expect(fs.lstatSync(dest()).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(elsewhere)).toEqual(["keep.txt"]);
    expect(installs()).toEqual([]);
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it.each([["data/releases/ai-worker"], ["data/releases"]])("refuses a symbolic link at %s before anything is changed (no lock, nothing written)", (rel) => {
    const elsewhere = path.join(base, "elsewhere");
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(main, rel));
    const r = prepare();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("is a symbolic link");
    expect(r.stderr).toContain("nothing was changed");
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(installs()).toEqual([]);
  });

  it("leaves tracked symbolic links and their targets alone when making the release read-only", () => {
    const target = path.join(base, "outside-target.txt");
    write(target, "outside\n", 0o644);
    fs.symlinkSync(target, path.join(main, "link-out"));
    const commit = (() => {
      git("add", "-A");
      git("commit", "-q", "-m", "link");
      return git("rev-parse", "HEAD");
    })();
    const r = prepare([commit, "--root", main]);
    expect(r.status).toBe(0);
    expect(fs.lstatSync(path.join(rdir(), commit, "link-out")).isSymbolicLink()).toBe(true);
    expect(mode(target)).toBe(0o644);
  });

  it("publishes only to a path that does not exist: a directory that appears there during the build is left alone (exit 1)", () => {
    const r = prepare([], { STUB_CREATE: dest() });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("appeared while building");
    expect(fs.readdirSync(dest())).toEqual([]);
    expect(leftovers()).toEqual([]);
    expect(fs.existsSync(lockDir())).toBe(false);
  });
});

describe("scripts/ops/prepare-release.sh: checks and failures", () => {
  it("a pnpm that does not match packageManager is refused before the install, with the corepack hint", () => {
    const r = prepare([], { STUB_PNPM_VERSION: "1.2.3" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`pnpm 1.2.3 does not match packageManager pnpm@${STUB_PNPM}`);
    expect(r.stderr).toContain("corepack enable");
    expect(installs()).toEqual([]);
    expect(entries()).toEqual([]);
  });

  it.each([
    ["the install fails", { STUB_INSTALL_EXIT: "1" }, "pnpm install failed"],
    ["the install leaves no tsx loader", { STUB_NO_LOADER: "1" }, "loader.mjs is missing"],
    ["git archive | tar fails", { STUB_TAR_FAIL: "1" }, "git archive of"],
  ])("%s: exit 1, its .tmp directory removed, no release, the lock released", (_label, env, message) => {
    const r = prepare([], env);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(message);
    expect(r.stdout).toBe("");
    expect(entries()).toEqual([]);
    expect(installs()).toHaveLength("STUB_TAR_FAIL" in env ? 0 : 1);
  });
});

describe("scripts/ops/prepare-release.sh: the lock", () => {
  it.each([
    ["a complete owner", ownerFixture, true],
    ["a half-written owner", "token=0123456789abcdef0123456789abcdef\npid=99", false],
    ["an owner on another host", ownerFixture.replace("wrapper-host", "elsewhere"), true],
  ])("an existing lock with %s: refused (exit 1), nothing changed", (_label, owner, reported) => {
    fs.mkdirSync(path.join(lockDir(), "inflight"), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), "owner"), owner);
    const r = prepare();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not take the release lock");
    if (reported) expect(r.stderr).toContain("owner: pid 999999");
    expect(r.stderr).not.toContain("0123456789abcdef0123456789abcdef");
    expect(fs.readFileSync(path.join(lockDir(), "owner"), "utf8")).toBe(owner);
    expect(fs.readdirSync(path.join(lockDir(), "inflight"))).toEqual([]);
    expect(entries()).toEqual([".lock"]);
    expect(installs()).toEqual([]);
  });

  it("an inherited token that does not match is refused: with no lock (no lock is made) and against another owner", () => {
    const token = "f".repeat(32);
    const none = prepare([], { JOB_RADAR_RELEASES_LOCK_TOKEN: token });
    expect(none.status).toBe(1);
    expect(fs.existsSync(lockDir())).toBe(false);

    fs.mkdirSync(path.join(lockDir(), "inflight"), { recursive: true });
    fs.writeFileSync(path.join(lockDir(), "owner"), ownerFixture);
    const other = prepare([], { JOB_RADAR_RELEASES_LOCK_TOKEN: token });
    expect(other.status).toBe(1);
    expect(fs.readFileSync(path.join(lockDir(), "owner"), "utf8")).toBe(ownerFixture);
    expect(installs()).toEqual([]);
  });

  it("re-entered with the caller's token: it builds, registers and removes only its own record; the caller still holds the lock afterwards", () => {
    const r = caller(`
      releases_lock_acquire "$MAIN" || exit 9
      before="$(cat "$MAIN/data/releases/ai-worker/.lock/owner")"
      bash "$SCRIPT" "$SHA" --root "$MAIN"; echo "prc=$?"
      [[ "$(cat "$MAIN/data/releases/ai-worker/.lock/owner")" == "$before" ]] && echo owner-same
      echo "records=$(ls -A "$MAIN/data/releases/ai-worker/.lock/inflight" | wc -l | tr -d ' ')"
      releases_lock_verify "$MAIN" && echo still-held
      releases_lock_release "$MAIN"; echo "lrc=$?"`);
    expect(r.stdout).toContain(`${dest()}\nprc=0`);
    expect(r.stdout).toContain("owner-same");
    expect(r.stdout).toContain("records=0");
    expect(r.stdout).toContain("still-held");
    expect(r.stdout).toContain("lrc=0");
    expect(fs.existsSync(lockDir())).toBe(false);
  });

  it("re-entered and failing: its .tmp directory stays for the lock holder's sweep_tmp, which removes it", () => {
    const r = caller(
      `
      releases_lock_acquire "$MAIN" || exit 9
      bash "$SCRIPT" "$SHA" --root "$MAIN"; echo "prc=$?"
      echo "after=$(cd "$MAIN/data/releases/ai-worker" && ls -A | grep -c '^\\.tmp-' )"
      sweep_tmp "$MAIN"; echo "swept=$?"
      echo "left=$(cd "$MAIN/data/releases/ai-worker" && ls -A | grep -c '^\\.tmp-' )"
      releases_lock_release "$MAIN"; echo "lrc=$?"`,
      { STUB_INSTALL_EXIT: "1" },
    );
    expect(r.stdout).toContain("prc=1");
    expect(r.stdout).toContain("after=1");
    expect(r.stdout).toContain("swept=0");
    expect(r.stdout).toContain("left=0");
    expect(r.stdout).toContain("lrc=0");
    expect(entries()).toEqual([]);
  });

  it("another in-flight record appears while it runs (a descendant not confirmed): the lock and the .tmp directory are kept, exit 1", () => {
    const extra = path.join(lockDir(), "inflight", "424242");
    const r = prepare([], { STUB_INSTALL_EXIT: "1", STUB_EXTRA_RECORD: extra });
    expect(r.status).toBe(1);
    expect(fs.existsSync(path.join(lockDir(), "owner"))).toBe(true);
    expect(fs.readdirSync(path.join(lockDir(), "inflight"))).toEqual(["424242"]);
    expect(leftovers()).toHaveLength(1);
    expect(leftovers()[0]).toMatch(new RegExp(`^\\.tmp-${sha}-\\d+$`));
  });
});

describe("scripts/ops/prepare-release.sh: signals", () => {
  const continueFile = (): string => path.join(base, "continue");

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)("%s while pnpm install runs: the install finishes undisturbed, then the .tmp is removed, the lock released, exit %i", async (signal, code) => {
    try {
      const run = startPrepare({ BLOCK_CONTINUE: continueFile() });
      await waitFor("the install to start", () => logLines().some((l) => l.startsWith("# install started")));
      process.kill(-run.pid, signal);
      await sleep(300);
      // nothing is cleaned up while the step runs
      expect(fs.existsSync(lockDir())).toBe(true);
      expect(leftovers()).toHaveLength(1);
      fs.writeFileSync(continueFile(), "");
      const r = await run.done;
      expect(r.status).toBe(code);
      expect(logLines().some((l) => l.startsWith("# install signal"))).toBe(false);
      expect(logLines()).toContain("# install exit ctx=0 lock=1");
      expect(r.stdout).toBe("");
      expect(entries()).toEqual([]);
    } finally {
      fs.writeFileSync(continueFile(), "");
    }
  });

  it("SIGHUP with another in-flight record present: the lock and the .tmp directory are kept, exit 129 (the signal wins)", async () => {
    try {
      const extra = path.join(lockDir(), "inflight", "424242");
      const run = startPrepare({ BLOCK_CONTINUE: continueFile(), STUB_EXTRA_RECORD: extra });
      await waitFor("the install to start", () => logLines().some((l) => l.startsWith("# install started")));
      process.kill(-run.pid, "SIGHUP");
      await sleep(200);
      fs.writeFileSync(continueFile(), "");
      const r = await run.done;
      expect(r.status).toBe(129);
      expect(fs.readdirSync(path.join(lockDir(), "inflight"))).toEqual(["424242"]);
      expect(leftovers()).toHaveLength(1);
    } finally {
      fs.writeFileSync(continueFile(), "");
    }
  });

  it("a re-entered prepare killed with SIGKILL while the install blocks: its record stays, and the caller's release keeps the lock (3)", () => {
    const cont = continueFile();
    const r = caller(
      `
      releases_lock_acquire "$MAIN" || exit 9
      bash "$SCRIPT" "$SHA" --root "$MAIN" >/dev/null 2>&1 &
      p=$!
      for _ in $(seq 400); do grep -q '^# install started' "$STUB_LOG" 2>/dev/null && break; sleep 0.05; done
      kill -9 "$p"; wait "$p" 2>/dev/null
      : > "${cont}"
      for _ in $(seq 400); do grep -q '^# install exit' "$STUB_LOG" 2>/dev/null && break; sleep 0.05; done
      echo "records=$(cat "$MAIN"/data/releases/ai-worker/.lock/inflight/* | grep -c '^script=prepare-release$')"
      releases_lock_release "$MAIN" >/dev/null 2>&1; echo "lrc=$?"`,
      { BLOCK_CONTINUE: cont },
    );
    expect(r.stdout).toContain("records=1");
    expect(r.stdout).toContain("lrc=3");
    expect(fs.existsSync(path.join(lockDir(), "owner"))).toBe(true);
    expect(logLines().some((l) => l.startsWith("# install signal"))).toBe(false);
  });
});
