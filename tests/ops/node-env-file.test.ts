// @vitest-environment node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

/** `node --env-file-if-exists` is what the config scripts rely on: the file fills in what the environment lacks. */
let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-env-file-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function run(env: Record<string, string>, file: string) {
  const base: Record<string, string> = { PATH: process.env.PATH ?? "" };
  const result = spawnSync(process.execPath, [`--env-file-if-exists=${file}`, "-e", 'process.stdout.write(process.env.PROBE_VALUE ?? "unset")'], { env: { ...base, ...env } as NodeJS.ProcessEnv, encoding: "utf8" });
  return { status: result.status, out: result.stdout };
}

describe("node --env-file-if-exists", () => {
  it("keeps the value from the environment over the one in the file", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PROBE_VALUE=file\n");
    expect(run({ PROBE_VALUE: "env" }, file)).toEqual({ status: 0, out: "env" });
  });

  it("uses the file when the environment does not set the variable", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PROBE_VALUE=file\n");
    expect(run({}, file)).toEqual({ status: 0, out: "file" });
  });

  it("an empty value in the environment still wins over the file", () => {
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PROBE_VALUE=file\n");
    expect(run({ PROBE_VALUE: "" }, file)).toEqual({ status: 0, out: "" });
  });

  it("a missing file is not an error", () => {
    expect(run({ PROBE_VALUE: "env" }, path.join(dir, "absent.env"))).toEqual({ status: 0, out: "env" });
    expect(run({}, path.join(dir, "absent.env"))).toEqual({ status: 0, out: "unset" });
  });
});
