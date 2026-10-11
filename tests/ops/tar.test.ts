// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseTar, readTarGz, splitTarName, tarChunks, TarError, writeTarGz } from "@/lib/ops/tar";

let dir = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "job-radar-tar-"));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** The system tar (bsdtar on macOS, GNU tar on Linux) is the oracle: the archive must be readable by both. */
async function writeArchive(files: { name: string; data: Buffer; mode?: number }[]): Promise<string> {
  const archive = path.join(dir, "out.tgz");
  const { createWriteStream } = await import("node:fs");
  await writeTarGz(files, createWriteStream(archive));
  return archive;
}

describe("splitTarName", () => {
  it("keeps a short name whole and splits a long one at a slash into prefix and name", () => {
    expect(splitTarName("data/config/me.yaml")).toEqual({ prefix: "", name: "data/config/me.yaml" });
    const long = `data/profile/${"d".repeat(60)}/${"e".repeat(60)}/file.txt`;
    const { prefix, name } = splitTarName(long);
    expect(`${prefix}/${name}`).toBe(long);
    expect(Buffer.byteLength(name)).toBeLessThanOrEqual(100);
    expect(Buffer.byteLength(prefix)).toBeLessThanOrEqual(155);
  });

  it("throws when no split fits", () => {
    expect(() => splitTarName(`data/${"x".repeat(120)}`)).toThrow(TarError);
    expect(() => splitTarName(`${"a".repeat(200)}/${"b".repeat(10)}`)).toThrow(TarError);
  });
});

describe("writeTarGz", () => {
  it("is read by the system tar: members, contents, modes, a long path, an empty file and a multi-block file", async () => {
    const big = Buffer.alloc(5000, "z");
    const longName = `data/profile/${"p".repeat(70)}/${"q".repeat(70)}/resume.md`;
    const archive = await writeArchive([
      { name: "data/config/me.yaml", data: Buffer.from("name: x\n"), mode: 0o600 },
      { name: "data/config/empty.yaml", data: Buffer.alloc(0) },
      { name: "data/config/big.bin", data: big },
      { name: longName, data: Buffer.from("long") },
    ]);

    const listed = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
    expect(listed.status, listed.stderr).toBe(0);
    expect(listed.stdout.trim().split("\n").sort()).toEqual([longName, "data/config/big.bin", "data/config/empty.yaml", "data/config/me.yaml"].sort());

    const out = path.join(dir, "out");
    fs.mkdirSync(out);
    const extracted = spawnSync("tar", ["-xzf", archive, "-C", out], { encoding: "utf8" });
    expect(extracted.status, extracted.stderr).toBe(0);
    expect(fs.readFileSync(path.join(out, "data/config/me.yaml"), "utf8")).toBe("name: x\n");
    expect(fs.readFileSync(path.join(out, "data/config/big.bin")).equals(big)).toBe(true);
    expect(fs.statSync(path.join(out, "data/config/empty.yaml")).size).toBe(0);
    expect(fs.readFileSync(path.join(out, longName), "utf8")).toBe("long");
    expect(fs.statSync(path.join(out, "data/config/me.yaml")).mode & 0o777).toBe(0o600);
  });

  it("round-trips through the built-in reader", async () => {
    const archive = await writeArchive([
      { name: "a/b.txt", data: Buffer.from("hello") },
      { name: "c.txt", data: Buffer.alloc(513, 1) },
    ]);
    const members = await readTarGz(fs.readFileSync(archive));
    expect(members.map((m) => [m.name, m.size])).toEqual([
      ["a/b.txt", 5],
      ["c.txt", 513],
    ]);
    expect(members[0]?.data.toString()).toBe("hello");
  });

  it("rejects a corrupted header and a truncated archive", () => {
    const raw = Buffer.concat([...tarChunks([{ name: "x.txt", data: Buffer.from("abc") }])]);
    const flipped = Buffer.from(raw);
    flipped[0] = (flipped[0] ?? 0) ^ 0xff;
    expect(() => parseTar(flipped)).toThrow(/checksum/);
    expect(() => parseTar(raw.subarray(0, 600))).toThrow(TarError);
  });
});
