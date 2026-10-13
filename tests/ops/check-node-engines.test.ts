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
const RANGE = ">=22.22.3 <23";

describe("checkNodeEngines", () => {
  it("rejects a version below the minimum", () => {
    expect(checkNodeEngines(RANGE, "22.22.2")).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(checkNodeEngines(RANGE, "22.21.9")).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(checkNodeEngines(RANGE, "21.99.99")).toMatchObject({ ok: false, reason: "out-of-range" });
  });

  it("accepts the minimum and later versions of the same major", () => {
    expect(checkNodeEngines(RANGE, "22.22.3")).toEqual({ ok: true });
    expect(checkNodeEngines(RANGE, "v22.23.1")).toEqual({ ok: true });
    expect(checkNodeEngines(RANGE, "22.100.0")).toEqual({ ok: true });
  });

  it("rejects the excluded major and later", () => {
    expect(checkNodeEngines(RANGE, "23.0.0")).toMatchObject({ ok: false, reason: "out-of-range" });
    expect(checkNodeEngines(RANGE, "24.1.0")).toMatchObject({ ok: false, reason: "out-of-range" });
  });

  it("names the required range in the message", () => {
    const r = checkNodeEngines(RANGE, "22.22.2");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("22.22.3");
  });

  it.each([">=22 <23", "^22.22.3", ">=22.22.3", "22.x", ">=22.22.3 <23.1", ">= 22.22.3 < 23", ""])(
    "reports an unsupported range %j instead of guessing",
    (range) => {
      expect(parseEnginesRange(range)).toBeNull();
      expect(checkNodeEngines(range, "22.22.3")).toMatchObject({ ok: false, reason: "unsupported-range" });
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
