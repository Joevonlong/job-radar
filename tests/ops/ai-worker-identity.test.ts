// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * ai_worker_identity of scripts/ops/lib/ai-worker.sh: which service definition is the worker's, from files only. Every
 * case runs under `env -i` with a throw-away HOME / XDG_CONFIG_HOME and checkout, so nothing of this machine's
 * LaunchAgents or systemd units is looked at; no launchctl or systemctl is called.
 */
const lib = path.resolve(import.meta.dirname, "../../scripts/ops/lib/ai-worker.sh");
const DEFAULT = "io.jobradar.ai-worker";
const LEGACY = "de.jobradar.ai-worker";
const UNIT = "job-radar-ai-worker.service";

let tmp = "";
let home = "";
let main = "";

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-worker-identity-"));
  home = path.join(tmp, "home");
  main = path.join(tmp, "main");
  fs.mkdirSync(path.join(home, "Library/LaunchAgents"), { recursive: true });
  fs.mkdirSync(main);
});
afterEach(() => {
  if (tmp && path.basename(tmp).startsWith("ai-worker-identity-")) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = "";
});

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
const schedule = (label: string | null, where = "data/config"): void =>
  write(path.join(main, where, "schedule.yaml"), label === null ? "doctor:\n  other: 1\n" : `doctor:\n  ai_worker_launchd_label: ${label}\n`);
const plist = (label: string): string => {
  const file = path.join(home, "Library/LaunchAgents", `${label}.plist`);
  write(file, "<plist/>\n");
  return file;
};

// env -i: only PATH, HOME and what the case sets; `app` is set to a directory that does not exist (no dependence on it)
function run(snippet: string, env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } {
  const vars = Object.entries({ PATH: "/usr/bin:/bin", HOME: home, app: path.join(tmp, "no-such-app"), ...env }).map(([k, v]) => `${k}=${v}`);
  const r = spawnSync("/usr/bin/env", ["-i", ...vars, "/bin/bash", "-c", `source "${lib}"; ${snippet}`, "_", main], { encoding: "utf8", timeout: 20_000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}
const identity = (env: Record<string, string> = {}) => run('ai_worker_identity "$1"', { JOB_RADAR_SERVICE_MANAGER: "launchd", ...env });
const kv = (stdout: string): Record<string, string> =>
  Object.fromEntries(stdout.split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));

describe("ai_worker_identity (launchd)", () => {
  it("a custom label with its own plist: resolved", () => {
    schedule("com.example.worker");
    const file = plist("com.example.worker");
    const r = identity();
    expect(r.status).toBe(0);
    expect(r.stdout.split("\n").filter(Boolean).map((l) => l.split("=")[0])).toEqual(["platform", "label", "definition", "found_label", "found_definition", "origin"]);
    expect(kv(r.stdout)).toEqual({
      platform: "launchd",
      label: "com.example.worker",
      definition: file,
      found_label: "com.example.worker",
      found_definition: file,
      origin: "resolved",
    });
  });

  it("a custom label without a plist, the default label's plist present: default", () => {
    schedule('"com.example.worker"');
    const file = plist(DEFAULT);
    const r = identity();
    expect(r.status).toBe(0);
    expect(kv(r.stdout)).toMatchObject({ label: "com.example.worker", found_label: DEFAULT, found_definition: file, origin: "default" });
  });

  it("only the legacy plist: legacy", () => {
    const file = plist(LEGACY);
    const r = identity();
    expect(r.status).toBe(0);
    expect(kv(r.stdout)).toMatchObject({ label: DEFAULT, found_label: LEGACY, found_definition: file, origin: "legacy" });
  });

  it("no plist at all: none, with empty found_* values", () => {
    schedule(null);
    const r = identity();
    expect(r.status).toBe(0);
    expect(kv(r.stdout)).toEqual({
      platform: "launchd",
      label: DEFAULT,
      definition: path.join(home, "Library/LaunchAgents", `${DEFAULT}.plist`),
      found_label: "",
      found_definition: "",
      origin: "none",
    });
  });

  it.each([
    ["the resolved and the legacy plist", ["com.example.worker", LEGACY]],
    ["the resolved and the default plist", ["com.example.worker", DEFAULT]],
    ["the default and the legacy plist", [DEFAULT, LEGACY]],
  ])("%s: ambiguous, exit 1; stdout stops after definition, both files on stderr", (_label, labels) => {
    schedule("com.example.worker");
    const files = labels.map(plist);
    const r = identity();
    expect(r.status).toBe(1);
    expect(Object.keys(kv(r.stdout))).toEqual(["platform", "label", "definition"]);
    for (const f of files) expect(r.stderr).toContain(f);
  });

  it("the default label configured explicitly and its plist present: counted once (resolved)", () => {
    schedule(DEFAULT);
    plist(DEFAULT);
    const r = identity();
    expect(r.status).toBe(0);
    expect(kv(r.stdout)).toMatchObject({ found_label: DEFAULT, origin: "resolved" });
  });

  it.each([["bad/label"], ["$(touch pwned)"], ["a;b"]])("an invalid label %s: exit 1 after platform, nothing evaluated", (label) => {
    schedule(`"${label}"`);
    const r = identity();
    expect(r.status).toBe(1);
    expect(Object.keys(kv(r.stdout))).toEqual(["platform"]);
    expect(r.stderr).toContain("not a valid label");
    expect(fs.existsSync(path.join(main, "pwned"))).toBe(false);
  });

  it.each([
    ["com.example.worker invalid"],
    ['"com.example.worker invalid"'],
    ["'com.example.worker invalid'"],
  ])("the whole scalar is the label: %s is not valid (exit 1 after platform)", (value) => {
    schedule(value);
    const r = identity();
    expect(r.status).toBe(1);
    expect(Object.keys(kv(r.stdout))).toEqual(["platform"]);
    expect(r.stderr).toContain("not a valid label");
  });

  it.each([['"com.example.worker'], ['"com.example.worker" trailing'], ["'a.b'c"], ['"a.b"#no-space']])("a malformed quoted value %s: exit 1", (value) => {
    schedule(value);
    const r = identity();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("not a plain or quoted scalar");
  });

  it.each([
    ["com.example.worker", "com.example.worker"],
    ["com.example.worker   # a comment", "com.example.worker"],
    ["com.example.worker # a # b", "com.example.worker"],
    ["com.example.worker\t# tab before the comment", "com.example.worker"],
    ['"com.example.worker" # a # b', "com.example.worker"],
    ['"com.example.worker"  # a comment', "com.example.worker"],
    ["'com.example.worker'", "com.example.worker"],
    ["com.example.worker\r", "com.example.worker"],
    ["# only a comment", DEFAULT],
  ])("reads %j as %s", (value, label) => {
    schedule(value.replace("\\r", "\r"));
    const r = identity();
    expect(r.status).toBe(0);
    expect(kv(r.stdout).label).toBe(label);
  });

  it("the label comes from data/config when that file exists, else from config/; an empty value is the default", () => {
    schedule("from.config", "config");
    expect(kv(identity().stdout).label).toBe("from.config");
    schedule("from.data");
    expect(kv(identity().stdout).label).toBe("from.data");
    schedule('""');
    expect(kv(identity().stdout).label).toBe(DEFAULT);
  });

  it("an unreadable schedule.yaml: exit 1", () => {
    if (process.getuid?.() === 0) return; // root reads anything
    schedule("x.y");
    fs.chmodSync(path.join(main, "data/config/schedule.yaml"), 0o000);
    const r = identity();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("cannot read");
  });

  it("does not depend on $app: the same output with app unset", () => {
    schedule("com.example.worker");
    plist("com.example.worker");
    const withApp = identity();
    const r = spawnSync("/usr/bin/env", ["-i", "PATH=/usr/bin:/bin", `HOME=${home}`, "JOB_RADAR_SERVICE_MANAGER=launchd", "/bin/bash", "-c", `source "${lib}"; ai_worker_identity "$1"`, "_", main], {
      encoding: "utf8",
    });
    expect(r.stdout).toBe(withApp.stdout);
  });
});

describe("ai_worker_identity (systemd)", () => {
  it("the user unit under XDG_CONFIG_HOME: resolved; without it: none", () => {
    const xdg = path.join(tmp, "xdg");
    const unit = path.join(xdg, "systemd/user", UNIT);
    const none = identity({ JOB_RADAR_SERVICE_MANAGER: "systemd", XDG_CONFIG_HOME: xdg });
    expect(none.status).toBe(0);
    expect(kv(none.stdout)).toEqual({ platform: "systemd", label: DEFAULT, definition: unit, found_label: "", found_definition: "", origin: "none" });
    write(unit, "[Service]\n");
    const r = identity({ JOB_RADAR_SERVICE_MANAGER: "systemd", XDG_CONFIG_HOME: xdg });
    expect(kv(r.stdout)).toMatchObject({ found_label: UNIT, found_definition: unit, origin: "resolved" });
  });

  it("without XDG_CONFIG_HOME the unit is looked for under $HOME/.config; launchd plists do not count", () => {
    plist(DEFAULT);
    const unit = path.join(home, ".config/systemd/user", UNIT);
    write(unit, "[Service]\n");
    const r = identity({ JOB_RADAR_SERVICE_MANAGER: "systemd" });
    expect(r.status).toBe(0);
    expect(kv(r.stdout)).toMatchObject({ definition: unit, found_definition: unit, origin: "resolved" });
  });
});

describe("ai_worker_label (restore.sh): the output is unchanged", () => {
  // the function as it was before ai_worker_identity existed, verbatim
  const before = `ai_worker_label_before() {
  local schedule="$app/data/config/schedule.yaml" label=""
  [[ -f "$schedule" ]] || schedule="$app/config/schedule.yaml"
  label="$(awk '/^doctor:/ { in_doctor = 1; next } /^[^ #]/ { in_doctor = 0 } in_doctor && $1 == "ai_worker_launchd_label:" { gsub(/["'"'"']/, "", $2); print $2; exit }' "$schedule" 2>/dev/null || true)"
  printf '%s' "\${label:-$AI_WORKER_DEFAULT_LABEL}"
}`;
  const both = (): { now: string; then: string } => {
    const r = run(`${before}\necho "now=$(ai_worker_label)"; echo "then=$(ai_worker_label_before)"`, { app: main });
    return { now: /now=(.*)/.exec(r.stdout)?.[1] ?? "?", then: /then=(.*)/.exec(r.stdout)?.[1] ?? "?" };
  };

  it.each([
    ["no schedule.yaml", () => {}],
    ["a custom label in data/config", () => schedule("com.example.worker")],
    ["a quoted label in config/", () => schedule("'com.example.other'", "config")],
    ["an empty label", () => schedule('""')],
    ["no label key", () => schedule(null)],
    ["two definitions (ambiguous identity)", () => (schedule("com.example.worker"), plist("com.example.worker"), plist(LEGACY))],
  ])("%s", (_label, setup) => {
    setup();
    const { now, then } = both();
    expect(now).toBe(then);
  });

  it("is the launchd label even where the platform would be systemd", () => {
    schedule("com.example.worker");
    const r = run('echo "$(ai_worker_label)"', { app: main, JOB_RADAR_SERVICE_MANAGER: "systemd" });
    expect(r.stdout.trim()).toBe("com.example.worker");
  });
});
