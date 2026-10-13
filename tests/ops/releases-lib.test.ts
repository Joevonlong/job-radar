// @vitest-environment node
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/ops/lib/releases.sh: the deploy lock (<main>/data/releases/ai-worker/.lock) and its in-flight records. Each case
 * runs /bin/bash snippets against a throw-away <main> directory; nothing here touches a real checkout.
 */
const repo = path.resolve(import.meta.dirname, "../..");
const releasesSh = path.join(repo, "scripts/ops/lib/releases.sh");
const ownerFixture = fs.readFileSync(path.join(repo, "tests/fixtures/ops/lock-owner-wrapper.txt"), "utf8");
const recordFixture = fs.readFileSync(path.join(repo, "tests/fixtures/ops/inflight-wrapper.txt"), "utf8");
const FIXTURE_TOKEN = "0123456789abcdef0123456789abcdef";
const PS_COMMAND =
  "ps -A -o pid,ppid,pgid,etime,command | grep -E '[d]ocker compose|[p]npm|[m]igrate|[c]onfig[:-]|[o]ps:drain|[p]repare-release|[i]nstall-ai-worker|[l]aunchctl|[s]ystemctl'";

let main = "";
let lock = "";

beforeEach(() => {
  main = fs.mkdtempSync(path.join(os.tmpdir(), "releases-lib-"));
  lock = path.join(main, "data/releases/ai-worker/.lock");
});
afterEach(() => fs.rmSync(main, { recursive: true, force: true }));

// Run a snippet with releases.sh sourced; MAIN is the throw-away checkout.
function sh(snippet: string, env: Record<string, string> = {}): { status: number | null; out: string; stdout: string } {
  const clean = { ...process.env };
  delete clean.JOB_RADAR_RELEASES_LOCK_TOKEN;
  const r = spawnSync("/bin/bash", ["-c", `set -u; source "${releasesSh}"; MAIN="${main}"; ${snippet}`], {
    encoding: "utf8",
    env: { ...clean, ...env },
    timeout: 20_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

function placeLock(owner: string, records: Record<string, string> = {}): void {
  fs.mkdirSync(path.join(lock, "inflight"), { recursive: true });
  fs.writeFileSync(path.join(lock, "owner"), owner);
  for (const [name, content] of Object.entries(records)) fs.writeFileSync(path.join(lock, "inflight", name), content);
}

const ownerText = (): string => fs.readFileSync(path.join(lock, "owner"), "utf8");
const inflight = (): string[] => fs.readdirSync(path.join(lock, "inflight")).sort();
const deadPid = (): number => {
  const r = spawnSync("/bin/bash", ["-c", "echo $$"], { encoding: "utf8" });
  return Number(r.stdout.trim());
};

describe("scripts/ops/lib/releases.sh: the lock", () => {
  it("passes bash -n", () => {
    expect(spawnSync("/bin/bash", ["-n", releasesSh]).status).toBe(0);
  });

  it("creates the parent directory first, then takes the lock; the owner file has exactly the four lines", () => {
    const r = sh('releases_lock_acquire "$MAIN"; echo "rc=$? mine=$RELEASES_LOCK_MINE token=$JOB_RADAR_RELEASES_LOCK_TOKEN"');
    expect(r.stdout).toMatch(/^rc=0 mine=1 token=[0-9a-f]{32}$/m);
    const token = /token=([0-9a-f]{32})/.exec(r.stdout)?.[1];
    const lines = ownerText().split("\n");
    expect(lines.pop()).toBe("");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe(`token=${token}`);
    expect(lines[1]).toMatch(/^pid=\d+$/);
    expect(lines[2]).toMatch(/^host=\S+$/);
    expect(lines[3]).toMatch(/^started=\d+$/);
    expect(fs.existsSync(path.join(lock, "owner.tmp"))).toBe(false);
    expect(inflight()).toEqual([]);
  });

  it.each([
    ["a complete owner", ownerFixture],
    ["a half-written owner", "token=0123456789abcdef0123456789abcdef\npid=99"],
    ["an owner on another host", ownerFixture.replace("wrapper-host", "elsewhere")],
    ["no owner file at all", ""],
  ])("refuses an existing lock with %s, and leaves it alone", (_label, owner) => {
    if (owner) placeLock(owner);
    else fs.mkdirSync(lock, { recursive: true });
    const before = owner ? ownerText() : null;
    const r = sh('releases_lock_acquire "$MAIN"; echo "rc=$? mine=$RELEASES_LOCK_MINE token=${JOB_RADAR_RELEASES_LOCK_TOKEN:-none}"');
    expect(r.stdout).toContain("rc=1 mine=0 token=none");
    if (before !== null) expect(ownerText()).toBe(before);
    else expect(fs.readdirSync(lock)).toEqual([]);
  });

  it("only one of two processes that try at the same moment gets the lock", async () => {
    for (let round = 0; round < 5; round += 1) {
      fs.rmSync(path.join(main, "data"), { recursive: true, force: true });
      const run = (): Promise<string> =>
        new Promise((resolve) => {
          const child = spawn("/bin/bash", ["-c", `source "${releasesSh}"; releases_lock_acquire "${main}" 2>/dev/null; echo "rc=$?"`], {
            env: { ...process.env, JOB_RADAR_RELEASES_LOCK_TOKEN: "" },
          });
          let out = "";
          child.stdout.on("data", (d: Buffer) => (out += d.toString()));
          child.on("close", () => resolve(out.trim()));
        });
      const results = await Promise.all([run(), run(), run()]);
      expect(results.filter((r) => r === "rc=0"), results.join(",")).toHaveLength(1);
    }
  });

  it("an inherited token that matches re-enters (not the owner); a child that re-entered leaves the owner untouched", () => {
    const r = sh(
      'releases_lock_acquire "$MAIN"; owner_before="$(cat "$MAIN/data/releases/ai-worker/.lock/owner")"\n' +
        // the child inherits the exported token, not RELEASES_LOCK_MINE
        `/bin/bash -c 'source "${releasesSh}"; env | grep -c "^RELEASES_LOCK_MINE=" || true; releases_lock_acquire "$1"; echo "child rc=$? mine=$RELEASES_LOCK_MINE"; releases_inflight_register "$1" child.sh; releases_lock_release "$1"; echo "child release rc=$?"' _ "$MAIN"\n` +
        'owner_after="$(cat "$MAIN/data/releases/ai-worker/.lock/owner")"; [[ "$owner_before" == "$owner_after" ]] && echo "owner unchanged"; echo "parent mine=$RELEASES_LOCK_MINE"; ls "$MAIN/data/releases/ai-worker/.lock/inflight" | wc -l | tr -d " "',
    );
    expect(r.stdout.split("\n")).toEqual(["0", "child rc=0 mine=0", "child release rc=0", "owner unchanged", "parent mine=1", "0", ""]);
  });

  it("a token that does not match is refused: against another owner, and with no lock at all (no new lock is made)", () => {
    placeLock(ownerFixture);
    const other = sh('releases_lock_acquire "$MAIN"; echo "rc=$? mine=$RELEASES_LOCK_MINE"', { JOB_RADAR_RELEASES_LOCK_TOKEN: "f".repeat(32) });
    expect(other.stdout).toContain("rc=1 mine=0");
    expect(other.out).toContain("inherited lock token does not match");
    expect(ownerText()).toBe(ownerFixture);
    fs.rmSync(lock, { recursive: true });
    const none = sh('releases_lock_acquire "$MAIN"; echo "rc=$?"', { JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN });
    expect(none.stdout).toContain("rc=1");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it("reads an owner written by another implementation (fixture): the same token re-enters, another is refused", () => {
    placeLock(ownerFixture);
    expect(sh('releases_lock_acquire "$MAIN"; echo "rc=$? mine=$RELEASES_LOCK_MINE"', { JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN }).stdout).toContain("rc=0 mine=0");
    expect(sh('releases_lock_acquire "$MAIN"; echo "rc=$?"', { JOB_RADAR_RELEASES_LOCK_TOKEN: "a".repeat(32) }).stdout).toContain("rc=1");
    expect(sh('releases_lock_owner_read "$MAIN"').stdout).toBe(ownerFixture);
    expect(ownerText()).toBe(ownerFixture);
  });

  it("checking the token never changes ownership: verify and a second acquire keep RELEASES_LOCK_MINE=1, and release removes the lock", () => {
    const r = sh(
      'releases_lock_acquire "$MAIN"; releases_lock_verify "$MAIN"; echo "verify=$? mine=$RELEASES_LOCK_MINE"; releases_lock_acquire "$MAIN"; echo "again=$? mine=$RELEASES_LOCK_MINE"; releases_lock_release "$MAIN"; echo "release=$? mine=$RELEASES_LOCK_MINE"',
    );
    expect(r.stdout.split("\n")).toEqual(["verify=0 mine=1", "again=0 mine=1", "release=0 mine=0", ""]);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.existsSync(path.dirname(lock))).toBe(true);
  });

  it("releasing does not remove a lock whose owner token is no longer this process's", () => {
    const r = sh(
      `releases_lock_acquire "$MAIN"; printf '${ownerFixture.replaceAll("\n", "\\n")}' > "$MAIN/data/releases/ai-worker/.lock/owner"; releases_lock_release "$MAIN"; echo "release=$?"`,
    );
    expect(r.stdout).toContain("release=0");
    expect(ownerText()).toBe(ownerFixture);
  });

  describe("releases_lock_verify is read-only", () => {
    it.each([
      ["the same token", FIXTURE_TOKEN, true, 0],
      ["another token", "b".repeat(32), true, 1],
      ["no token", "", true, 1],
      ["no lock", FIXTURE_TOKEN, false, 1],
    ])("%s -> %i", (_label, token, withLock, want) => {
      if (withLock) placeLock(ownerFixture);
      const r = sh('releases_lock_verify "$MAIN"; echo "rc=$? mine=$RELEASES_LOCK_MINE"', { JOB_RADAR_RELEASES_LOCK_TOKEN: token });
      expect(r.stdout).toContain(`rc=${want} mine=0`);
      if (withLock) expect(ownerText()).toBe(ownerFixture);
      else expect(fs.existsSync(path.dirname(lock))).toBe(false);
    });

    it("an unreadable owner -> 1", () => {
      placeLock("token=zzz\n");
      expect(sh('releases_lock_verify "$MAIN"; echo "rc=$?"', { JOB_RADAR_RELEASES_LOCK_TOKEN: FIXTURE_TOKEN }).stdout).toContain("rc=1");
      expect(ownerText()).toBe("token=zzz\n");
    });
  });
});

describe("scripts/ops/lib/releases.sh: in-flight records", () => {
  it("registering writes exactly three lines through inflight/.tmp-<pid>, then a rename", () => {
    const r = sh('mv() { echo "mv ${*##*/}" >&2; command mv "$@"; }; releases_lock_acquire "$MAIN" 2>/dev/null; releases_inflight_register "$MAIN" deploy.sh; echo "pid=$$"');
    const pid = /pid=(\d+)/.exec(r.stdout)?.[1] ?? "";
    expect(r.out).toContain(`mv .tmp-${pid} ${pid}`);
    const lines = fs.readFileSync(path.join(lock, "inflight", pid), "utf8").split("\n");
    expect(lines).toEqual(["script=deploy.sh", `pid=${pid}`, expect.stringMatching(/^started=\d+$/), ""]);
    expect(inflight()).toEqual([pid]);
  });

  it("the owner keeps the lock (3) while another record is there; its own record is removed; a second release does nothing", () => {
    const dead = deadPid();
    const r = sh(
      `releases_lock_acquire "$MAIN"; releases_inflight_register "$MAIN" deploy.sh; printf 'script=install-ai-worker.sh\\npid=${dead}\\nstarted=1\\n' > "$MAIN/data/releases/ai-worker/.lock/inflight/${dead}"\n` +
        'owner="$(cat "$MAIN/data/releases/ai-worker/.lock/owner")"; releases_lock_release "$MAIN"; echo "first=$?"; [[ "$(cat "$MAIN/data/releases/ai-worker/.lock/owner")" == "$owner" ]] && echo "owner kept"\n' +
        'echo "pid=$$"; releases_lock_release "$MAIN"; echo "second=$?"',
    );
    expect(r.stdout).toContain("first=3");
    expect(r.stdout).toContain("owner kept");
    expect(r.out).toContain("descendant exit not confirmed; lock left in place");
    expect(r.out).toContain(`${dead} ${dead} install-ai-worker.sh 1 gone`);
    expect(inflight()).toEqual([String(dead)]);
    expect(r.stdout).toContain("second=3");
  });

  it("without other records the owner removes the lock; a later release is a no-op", () => {
    const r = sh('releases_lock_acquire "$MAIN"; releases_inflight_register "$MAIN" deploy.sh; releases_lock_release "$MAIN"; echo "first=$?"; releases_lock_release "$MAIN"; echo "second=$?"');
    expect(r.stdout).toContain("first=0");
    expect(r.stdout).toContain("second=0");
    expect(fs.existsSync(lock)).toBe(false);
  });

  it.each([
    ["an unreadable file", "garbage", "not a record\n"],
    ["a half-written .tmp-<pid>", ".tmp-424242", "script=deploy.sh\n"],
    ["an empty file", "777777", ""],
  ])("%s in inflight/ also keeps the lock (3)", (_label, name, content) => {
    const r = sh(`releases_lock_acquire "$MAIN"; printf '${content.replaceAll("\n", "\\n")}' > "$MAIN/data/releases/ai-worker/.lock/inflight/${name}"; releases_lock_release "$MAIN"; echo "rc=$?"`);
    expect(r.stdout).toContain("rc=3");
    expect(fs.existsSync(path.join(lock, "owner"))).toBe(true);
    expect(inflight()).toEqual([name]);
  });

  it("PROC_CHILD_ABNORMAL=1 (a cooperative child that did not run its exit handler) keeps the lock (3)", () => {
    const r = sh('releases_lock_acquire "$MAIN"; PROC_CHILD_ABNORMAL=1; releases_lock_release "$MAIN"; echo "rc=$?"');
    expect(r.stdout).toContain("rc=3");
    expect(r.out).toContain("descendant exit not confirmed");
    expect(fs.existsSync(path.join(lock, "owner"))).toBe(true);
  });

  it("lists a record written by another implementation (fixture), unreadable entries and .tmp-* too", () => {
    placeLock(ownerFixture, { "999999": recordFixture, junk: "x\n", ".tmp-5": "script=a\n" });
    const r = sh('releases_inflight_list "$MAIN"');
    expect(r.stdout.split("\n").filter(Boolean).sort()).toEqual([".tmp-5 partial", "999999 999999 deploy-prod.sh 1760000000 gone", "junk unreadable"]);
  });

  it("the report shows owner, records and how to clear the lock, never the token", () => {
    const dead = deadPid();
    placeLock(ownerFixture, { [String(dead)]: `script=deploy.sh\npid=${dead}\nstarted=1\n`, odd: "?" });
    const r = sh('releases_lock_report "$MAIN"');
    expect(r.stdout).toMatch(/owner: pid 999999 on wrapper-host, held for \d+ s/);
    expect(r.stdout).toContain(`${dead} ${dead} deploy.sh 1 gone`);
    expect(r.stdout).toContain("odd unreadable");
    expect(r.stdout).toContain(PS_COMMAND);
    expect(r.stdout).toContain(`rm -rf ${lock}`);
    expect(r.stdout).not.toContain(FIXTURE_TOKEN);
    placeLock("broken\n");
    expect(sh('releases_lock_report "$MAIN"').stdout).toContain("owner unknown");
  });

  it("a re-entered child that is killed leaves its record, and the owner keeps the lock (3)", () => {
    const r = sh(
      'releases_lock_acquire "$MAIN"\n' +
        `/bin/bash -c 'source "${releasesSh}"; releases_lock_acquire "$1"; releases_inflight_register "$1" install-ai-worker.sh; kill -9 $$' _ "$MAIN"\n` +
        'releases_lock_release "$MAIN"; echo "rc=$?"',
    );
    expect(r.stdout).toContain("rc=3");
    expect(inflight()).toHaveLength(1);
  });
});
