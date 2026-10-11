// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/ops/backup.sh: run against a throw-away checkout with a stub `docker` that plays the db container.
 * Nothing here touches the real stack.
 */
const realScript = path.resolve(import.meta.dirname, "../../scripts/ops/backup.sh");

let tmp = "";
let app = "";
let stubs = "";
let out = "";

function write(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "backup-script-"));
  app = path.join(tmp, "checkout");
  stubs = path.join(tmp, "bin");
  out = path.join(tmp, "out");
  write(path.join(tmp, "checkout/scripts/ops/backup.sh"), fs.readFileSync(realScript, "utf8"), 0o755);
  write(path.join(tmp, "checkout/scripts/ops/lib/timezone.sh"), fs.readFileSync(path.resolve(import.meta.dirname, "../../scripts/ops/lib/timezone.sh"), "utf8"));
  // the shipped schedule says one zone, the user's another: the user's wins
  write(path.join(app, "config/schedule.yaml"), "timezone: Etc/GMT+12\n");
  write(path.join(app, "data/config/schedule.yaml"), "timezone: Pacific/Kiritimati\n");
  write(path.join(app, "data/config/.backup/2026-10-09T10-00-00Z/schedule.yaml"), "old\n");
  write(path.join(app, "data/config/.web-session-secret"), "signing-secret\n", 0o600);
  write(path.join(app, "data/profile/me.yaml"), "summary: x\n");
  // a tar that records the environment it was started with, then does the real work
  const realTar = spawnSync("which", ["tar"], { encoding: "utf8" }).stdout.trim();
  write(path.join(stubs, "tar"), `#!/usr/bin/env bash\necho "COPYFILE_DISABLE=\${COPYFILE_DISABLE:-unset}" >> "\${STUB_TAR_LOG:-/dev/null}"\nexec ${realTar} "$@"\n`, 0o755);
  write(
    path.join(stubs, "docker"),
    `#!/usr/bin/env bash
if [[ "$*" == *"ps --status running --services"* ]]; then echo db; exit 0; fi
if [[ "$*" == *to_char* ]]; then [[ "\${STUB_NO_STAMP:-}" == 1 ]] || echo 20300102-030405; exit 0; fi
if [[ "$*" == *"exec -T db"* ]]; then printf 'PGDMP-custom-body'; exit 0; fi
exit 0
`,
    0o755,
  );
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const backup = (...args: string[]) =>
  spawnSync("bash", [path.join(tmp, "checkout/scripts/ops/backup.sh"), "--dir", out, ...args], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
    timeout: 30_000,
  });

describe("scripts/ops/backup.sh", () => {
  it("passes bash -n", () => {
    expect(spawnSync("bash", ["-n", realScript]).status).toBe(0);
  });

  it("names the dump in the time zone of the user's schedule.yaml and archives data/config + data/profile next to it", () => {
    const r = backup("--label", "t1");
    expect(r.status, r.stderr).toBe(0);
    const day = spawnSync("date", ["+%Y%m%d"], { encoding: "utf8", env: { ...process.env, TZ: "Pacific/Kiritimati" } }).stdout.trim();
    const files = fs.readdirSync(out).sort();
    const dump = files.find((f) => f.endsWith("-t1.dump"));
    expect(dump).toMatch(new RegExp(`^jobradar-manual-${day}-\\d{6}-t1\\.dump$`));
    const archive = files.find((f) => f.endsWith("-t1.config.tgz"));
    expect(archive).toBe(dump?.replace(/\.dump$/, ".config.tgz"));
    expect(r.stdout).toContain("config written:");
    const listing = spawnSync("tar", ["-tzf", path.join(out, archive ?? "")], { encoding: "utf8" }).stdout;
    expect(listing).toContain("data/config/schedule.yaml");
    expect(listing).toContain("data/profile/me.yaml");
    expect(listing).not.toContain(".backup");
    expect(listing).not.toContain("web-session-secret"); // the signing secret of the login cookie is re-created, never archived
  });

  it("runs tar with COPYFILE_DISABLE=1 so a macOS tar writes no AppleDouble ._* members", () => {
    const log = path.join(tmp, "tar.log");
    fs.writeFileSync(log, "");
    const r = spawnSync("bash", [path.join(tmp, "checkout/scripts/ops/backup.sh"), "--dir", out, "--label", "apple"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, STUB_TAR_LOG: log },
      timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    expect(fs.readFileSync(log, "utf8")).toContain("COPYFILE_DISABLE=1");
    const archive = fs.readdirSync(out).find((f) => f.endsWith("-apple.config.tgz")) ?? "";
    const listing = spawnSync("tar", ["-tzf", path.join(out, archive)], { encoding: "utf8" }).stdout;
    expect(listing).not.toMatch(/(^|\/)\._/m);
  });

  describe("on a system without time zone data for the schedule's zone", () => {
    const run = (env: Record<string, string>, label: string) =>
      spawnSync("bash", [path.join(tmp, "checkout/scripts/ops/backup.sh"), "--dir", out, "--label", label], {
        encoding: "utf8",
        env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}`, ...env },
        timeout: 30_000,
      });
    let saved = "";
    beforeAll(() => {
      saved = fs.readFileSync(path.join(app, "data/config/schedule.yaml"), "utf8");
      write(path.join(app, "data/config/schedule.yaml"), "timezone: Nowhere/Fakeland\n");
    });
    afterAll(() => write(path.join(app, "data/config/schedule.yaml"), saved));

    it("takes the stamp from the database (which has its own zone data) instead of silently using UTC", () => {
      const r = run({}, "tzdb");
      expect(r.status, r.stderr).toBe(0);
      expect(fs.readdirSync(out)).toContain("jobradar-manual-20300102-030405-tzdb.dump");
      expect(r.stderr).not.toContain("warning");
    });

    it("falls back to UTC with a warning when the database cannot tell either", () => {
      const r = run({ STUB_NO_STAMP: "1" }, "tzutc");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain("no time zone data for 'Nowhere/Fakeland'");
      expect(fs.readdirSync(out).some((f) => /^jobradar-manual-\d{8}-\d{6}-tzutc\.dump$/.test(f))).toBe(true);
    });
  });

  it("creates the dump and the config archive readable by the owner only, even under a permissive umask", () => {
    const r = spawnSync("bash", ["-c", 'umask 000; exec bash "$0" --dir "$1" --label perm', path.join(tmp, "checkout/scripts/ops/backup.sh"), out], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${stubs}:${process.env.PATH ?? ""}` },
      timeout: 30_000,
    });
    expect(r.status, r.stderr).toBe(0);
    const files = fs.readdirSync(out).filter((f) => f.includes("-perm."));
    expect(files.length).toBe(2);
    for (const f of files) expect(fs.statSync(path.join(out, f)).mode & 0o777, f).toBe(0o600);
  });

  it("without a user directory reads the shipped schedule.yaml and archives only what exists", () => {
    fs.rmSync(path.join(app, "data/config"), { recursive: true, force: true });
    const r = backup("--label", "t2");
    expect(r.status, r.stderr).toBe(0);
    const day = spawnSync("date", ["+%Y%m%d"], { encoding: "utf8", env: { ...process.env, TZ: "Etc/GMT+12" } }).stdout.trim();
    const archive = fs.readdirSync(out).find((f) => f.endsWith("-t2.config.tgz")) ?? "";
    expect(archive).toMatch(new RegExp(`^jobradar-manual-${day}-`));
    const listing = spawnSync("tar", ["-tzf", path.join(out, archive)], { encoding: "utf8" }).stdout;
    expect(listing).toContain("data/profile/me.yaml");
    expect(listing).not.toContain("data/config");
  });
});
