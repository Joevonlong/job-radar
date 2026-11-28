// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkNodeEngines, parseEnginesRange } from "../../scripts/ops/check-node-engines.mjs";

/** scripts/ops/check-node-engines.mjs: the one parser of engines.node (release guard, Dockerfile stages). */
const repo = path.resolve(import.meta.dirname, "../..");
const script = path.join(repo, "scripts/ops/check-node-engines.mjs");
const RANGE = ">=26.13.1 <27";

describe("checkNodeEngines", () => {
  it("rejects a version below the minimum", () => {
    expect(checkNodeEngines(RANGE, "26.13.0")).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(checkNodeEngines(RANGE, "26.12.9")).toMatchObject({ ok: false, reason: "out-of-range" });
  });

  it("accepts the minimum and later versions of the same major", () => {
    expect(checkNodeEngines(RANGE, "26.13.1")).toEqual({ ok: true });
    expect(checkNodeEngines(RANGE, "v26.13.2")).toEqual({ ok: true });
    expect(checkNodeEngines(RANGE, "26.100.0")).toEqual({ ok: true });
  });

  it("rejects the excluded major and later", () => {
    expect(checkNodeEngines(RANGE, "27.0.0")).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(checkNodeEngines(RANGE, "28.1.0")).toMatchObject({ ok: false, reason: "out-of-range" });
  });

  it("tells a user on an older major which Node to install", () => {
    expect(checkNodeEngines(RANGE, "22.23.4")).toMatchObject({
      ok: false,
      reason: "out-of-range",
      message: expect.stringContaining("install Node 26.13.1 or later, below 27"),
    });
  });

  it.each([">=26 <27", "^26.13.1", ">=26.13.1", "26.x", ">=26.13.1 <27.1", ">= 26.13.1 < 27", ""])(
    "reports an unsupported range %j instead of guessing",
    (range) => {
      expect(parseEnginesRange(range)).toBeNull();
      expect(checkNodeEngines(range, "26.13.1")).toMatchObject({ ok: false, reason: "unsupported-range" });
    },
  );

  it("reports a version it cannot parse", () => {
    expect(checkNodeEngines(RANGE, "banana")).toMatchObject({ ok: false, reason: "bad-version" });
  });
});

describe("check-node-engines.mjs on the command line", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "engines-"));
  });
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (engines: unknown) => {
    const file = path.join(dir, "package.json");
    fs.writeFileSync(file, JSON.stringify(engines === undefined ? {} : { engines: { node: engines } }));
    return spawnSync(process.execPath, [script, file], { encoding: "utf8" });
  };
  const [maj, min, pat] = process.versions.node.split(".").map(Number) as [number, number, number];

  it("exits 0 when the running Node is in range", () => {
    expect(run(`>=${maj}.${min}.${pat} <${maj + 1}`).status).toBe(0);
  });

  it("exits 1 when the running Node is below the minimum", () => {
    const r = run(`>=${maj}.${min}.${pat + 1} <${maj + 1}`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("does not satisfy");
  });

  it("exits 1 when the running Node is at or above the excluded major", () => {
    expect(run(`>=${maj - 1}.0.0 <${maj}`).status).toBe(1);
  });

  it("exits 2 on a range it does not understand, or none", () => {
    expect(run(`^${maj}.0.0`).status).toBe(2);
    expect(run(undefined).status).toBe(2);
  });

  it("passes on the repository's own package.json under the Node running the tests", () => {
    expect(spawnSync(process.execPath, [script, path.join(repo, "package.json")], { encoding: "utf8" }).status).toBe(0);
  });
});
