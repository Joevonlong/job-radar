// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listArchiveMembers, writeConfigArchive, ConfigArchiveError } from "@/lib/ops/config-archive";

let dir = "";
let dirs: { config: string; profile: string };

function put(file: string, content: string, mode = 0o644): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-cfgarchive-"));
  dirs = { config: path.join(dir, "app/data/config"), profile: path.join(dir, "app/data/profile") };
  put(path.join(dirs.config, "schedule.yaml"), "timezone: UTC\n");
  put(path.join(dirs.config, "sources.yaml"), "proxies: [secret]\n", 0o600);
  put(path.join(dirs.config, "editor/nested.yaml"), "nested: 1\n");
  put(path.join(dirs.config, ".backup/schedule.yaml.1"), "old original\n");
  put(path.join(dirs.config, ".upgrade-freeze"), "marker");
  put(path.join(dirs.config, ".write.lock.guard.pending-fixture/owner"), "owner");
  put(path.join(dirs.config, ".write.lock"), "lock");
  put(path.join(dirs.profile, ".write.lock"), "lock");
  put(path.join(dirs.config, ".web-session-secret"), "do-not-archive\n", 0o600);
  put(path.join(dirs.config, "ai.yaml.partial"), "half written\n");
  put(path.join(dirs.profile, "me.yaml"), "name: Test\n");
  fs.symlinkSync("/etc/hosts", path.join(dirs.config, "hosts-link"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("writeConfigArchive", () => {
  it("archives data/config and data/profile under those names, without .backup, the session secret, partial files and symlinks", async () => {
    expect(await listArchiveMembers(dirs)).toEqual([
      "data/config/editor/nested.yaml",
      "data/config/schedule.yaml",
      "data/config/sources.yaml",
      "data/profile/me.yaml",
    ]);
    const destination = path.join(dir, "jobradar-20261007-033000.config.tgz");
    const result = await writeConfigArchive({ dirs, destination });
    expect(result.members).toBe(4);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith(".partial"))).toEqual([]);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);

    const listed = spawnSync("tar", ["-tzf", destination], { encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    const names = listed.stdout.trim().split("\n").sort();
    expect(names).toEqual(["data/config/editor/nested.yaml", "data/config/schedule.yaml", "data/config/sources.yaml", "data/profile/me.yaml"]);
    expect(names.join("\n")).not.toMatch(/\.backup|web-session-secret|hosts-link|partial/);

    // `tar -xzf -C <app>` puts it back where it came from (the layout of scripts/ops/backup.sh)
    const target = path.join(dir, "restored");
    fs.mkdirSync(target);
    expect(spawnSync("tar", ["-xzf", destination, "-C", target]).status).toBe(0);
    expect(fs.readFileSync(path.join(target, "data/config/schedule.yaml"), "utf8")).toBe("timezone: UTC\n");
    expect(fs.readFileSync(path.join(target, "data/profile/me.yaml"), "utf8")).toBe("name: Test\n");
  });

  it("works when the profile directory does not exist yet", async () => {
    fs.rmSync(dirs.profile, { recursive: true, force: true });
    const result = await writeConfigArchive({ dirs, destination: path.join(dir, "x.config.tgz") });
    expect(result.members).toBe(3);
  });

  it("fails when there is nothing to archive", async () => {
    fs.rmSync(path.join(dir, "app"), { recursive: true, force: true });
    await expect(writeConfigArchive({ dirs, destination: path.join(dir, "x.config.tgz") })).rejects.toBeInstanceOf(ConfigArchiveError);
    expect(fs.existsSync(path.join(dir, "x.config.tgz"))).toBe(false);
  });

  it("leaves no partial or final file when the destination write fails", async () => {
    const failing = (): Writable => new Writable({ write: (_c, _e, cb) => cb(Object.assign(new Error("disk full"), { code: "ENOSPC" })) });
    const error = await writeConfigArchive({ dirs, destination: path.join(dir, "x.config.tgz"), createDestination: failing }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConfigArchiveError);
    expect((error as Error).message).toContain("ENOSPC");
    expect(fs.readdirSync(dir).filter((n) => n.startsWith("x."))).toEqual([]);
  });
});
