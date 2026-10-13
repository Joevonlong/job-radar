// @vitest-environment node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHIPPED_CONFIG_ID_SHORT_LENGTH, ShippedConfigError, shippedConfigId, shippedConfigManifest, shippedConfigReportSchema, shortShippedConfigId } from "@/lib/config/shipped-id";

let root = "";
let dir = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "shipped-id-"));
  dir = path.join(root, "config");
  write("schedule.yaml", "timezone: Europe/Berlin\n");
  write("ai.yaml", "execution: host\n");
  write("packs/xx/pack.yaml", "id: xx\n");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, content: string): void {
  const file = path.join(dir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const sha = (content: string): string => createHash("sha256").update(content).digest("hex");

describe("shippedConfigManifest / shippedConfigId", () => {
  it("lists every regular file as `<sha256>  ./<path>`, sorted by path in byte order", async () => {
    write("a-b.yaml", "x\n");
    write("a/b.yaml", "y\n");
    write("B.yaml", "z\n");
    const manifest = await shippedConfigManifest(dir);
    const paths = manifest
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(66));
    // '-' (0x2d) < '/' (0x2f) < 'B' < 'a': byte order, not locale order
    expect(paths).toEqual(["./B.yaml", "./a-b.yaml", "./a/b.yaml", "./ai.yaml", "./packs/xx/pack.yaml", "./schedule.yaml"]);
    expect(manifest.split("\n")[0]).toBe(`${sha("z\n")}  ./B.yaml`);
    expect(manifest.endsWith("\n")).toBe(true);
  });

  it("is deterministic: the same files give the same id, wherever the directory is", async () => {
    const first = await shippedConfigId(dir);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await shippedConfigId(dir)).toBe(first);
    const copy = path.join(root, "copy");
    fs.cpSync(dir, copy, { recursive: true });
    expect(await shippedConfigId(copy)).toBe(first);
  });

  it("leaves out .DS_Store and ._* files at any depth", async () => {
    const before = await shippedConfigId(dir);
    write(".DS_Store", "noise");
    write("packs/.DS_Store", "noise");
    write("._schedule.yaml", "noise");
    write("packs/xx/._pack.yaml", "noise");
    expect(await shippedConfigId(dir)).toBe(before);
  });

  it.each([
    ["a changed file", () => write("ai.yaml", "execution: container\n")],
    ["a renamed file", () => fs.renameSync(path.join(dir, "ai.yaml"), path.join(dir, "ai2.yaml"))],
    ["a file moved to another folder", () => fs.renameSync(path.join(dir, "packs/xx/pack.yaml"), path.join(dir, "packs/pack.yaml"))],
    ["an added file", () => write("packs/yy/pack.yaml", "id: yy\n")],
    ["a deleted file", () => fs.rmSync(path.join(dir, "ai.yaml"))],
    ["an added empty file", () => write("empty.yaml", "")],
  ])("changes with %s", async (_name, change) => {
    const before = await shippedConfigId(dir);
    change();
    expect(await shippedConfigId(dir)).not.toBe(before);
  });

  it("ignores empty folders (only files count)", async () => {
    const before = await shippedConfigId(dir);
    fs.mkdirSync(path.join(dir, "empty"));
    expect(await shippedConfigId(dir)).toBe(before);
  });

  it.each([
    ["a file name with a newline", () => write("bad\nname.yaml", "x"), /newline or backslash/],
    ["a file name with a backslash", () => write("bad\\name.yaml", "x"), /newline or backslash/],
    ["a folder name with a newline", () => write("bad\ndir/x.yaml", "x"), /newline or backslash/],
    ["a symbolic link to a file", () => fs.symlinkSync(path.join(dir, "ai.yaml"), path.join(dir, "link.yaml")), /symbolic link.*\.\/link\.yaml/],
    ["a symbolic link to a folder", () => fs.symlinkSync(path.join(dir, "packs"), path.join(dir, "packs2")), /symbolic link.*\.\/packs2/],
    ["a dangling symbolic link", () => fs.symlinkSync(path.join(root, "nowhere"), path.join(dir, "gone.yaml")), /symbolic link/],
  ])("refuses %s", async (_name, make, message) => {
    make();
    const error = await shippedConfigId(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ShippedConfigError);
    expect((error as Error).message).toMatch(message);
  });

  it("refuses a missing directory and a path that is a file", async () => {
    await expect(shippedConfigId(path.join(root, "missing"))).rejects.toThrow(/does not exist/);
    await expect(shippedConfigId(path.join(dir, "ai.yaml"))).rejects.toThrow(/not a directory/);
  });

  it("has an empty manifest for an empty directory", async () => {
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    expect(await shippedConfigManifest(empty)).toBe("");
  });

  it("shows the first characters to people", () => {
    expect(SHIPPED_CONFIG_ID_SHORT_LENGTH).toBe(12);
    expect(shortShippedConfigId("0123456789abcdef".repeat(4))).toBe("0123456789ab");
  });
});

describe("the same identity from the shell", () => {
  // What a shell script (or a person) runs in the directory; it must give the same id as the TypeScript code.
  const SCRIPT = String.raw`
set -euo pipefail
if command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$@"; }; else sum() { shasum -a 256 "$@"; }; fi
cd "$1"
find . -type f ! -name .DS_Store ! -name '._*' | LC_ALL=C sort | while IFS= read -r f; do sum "$f"; done | sum | cut -d' ' -f1
`;

  it("find | LC_ALL=C sort | sha256sum gives the same id", async () => {
    write("a-b.yaml", "x\n");
    write("a/b.yaml", "y\n");
    write("Z.yaml", "z\n");
    write("with space.yaml", "s\n");
    write("ümlaut.yaml", "u\n");
    write(".DS_Store", "noise");
    write("packs/._pack.yaml", "noise");
    const out = spawnSync("bash", ["-c", SCRIPT, "bash", dir], { encoding: "utf8", timeout: 20_000 });
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout.trim()).toBe(await shippedConfigId(dir));
  });
});

describe("shippedConfigReportSchema", () => {
  const report = { id: "a".repeat(64), dir: "/app/config", instance: "0123456789ab", pid: 1, startedAt: "2026-10-07T12:00:00.000Z" };

  it("accepts a report, with or without the release", () => {
    expect(shippedConfigReportSchema.parse(report)).toEqual(report);
    expect(shippedConfigReportSchema.parse({ ...report, release: "b".repeat(40) }).release).toBe("b".repeat(40));
  });

  it.each([
    ["a short id", { id: "abc" }],
    ["an upper-case id", { id: "A".repeat(64) }],
    ["an empty dir", { dir: "" }],
    ["an empty instance", { instance: "" }],
    ["pid 0", { pid: 0 }],
    ["a fractional pid", { pid: 1.5 }],
    ["a start that is no time", { startedAt: "yesterday" }],
    ["a short release", { release: "abc" }],
    ["an unknown field", { extra: 1 }],
  ])("refuses %s", (_name, edit) => {
    expect(shippedConfigReportSchema.safeParse({ ...report, ...edit }).success).toBe(false);
  });
});
