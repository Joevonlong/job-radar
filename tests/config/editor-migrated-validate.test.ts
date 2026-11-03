// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configLayer, hashConfigText, loadConfig, readConfigText, validateConfigText, writeConfigText, type TextIssue } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

/** The advanced editor and an older file: it is validated on the value its migration gives, and saved exactly as written. */
let tmp: TempConfig;
beforeEach(() => { tmp = makeTempConfig(); });
afterEach(() => tmp.cleanup());

/** The fixture is written without config_version (= 1); the editor wants the version written down. */
const OLD_NOTIFY = `config_version: 1\n${fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/notify.v1.yaml"), "utf8")}`;
const userFile = () => path.join(tmp.configDir, "notify.yaml");
const lineOf = (text: string, issue: TextIssue) => text.split("\n")[issue.line - 1] ?? "";

function failures(text: string): TextIssue[] {
  const result = validateConfigText("notify", text);
  if (result.ok) throw new Error("expected issues");
  return result.issues;
}

describe("validateConfigText on a file older than the code", () => {
  it("accepts it and returns the migrated value", () => {
    const result = validateConfigText("notify", OLD_NOTIFY);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    // the old key reads as the new one, with its value
    expect(result.value.push_min_score_high_value).toBe(60);
    expect(Object.keys(result.value)).not.toContain("push_min_score_with_t1_t2");
  });

  it("points an error on a key the user wrote at that key's own line", () => {
    const text = OLD_NOTIFY.replace("push_min_score: 70", "push_min_score: 700");
    const [issue] = failures(text);
    expect(issue).toMatchObject({ source: "schema", path: "push_min_score", exact: true });
    expect(lineOf(text, issue as TextIssue)).toContain("push_min_score: 700");
    // the message is the schema's own, not rewritten
    expect(issue?.message.startsWith("push_min_score")).toBe(false);
  });

  it("reports an error on a path only the migration creates on line 1, with the path in the message", () => {
    const text = OLD_NOTIFY.replace("push_min_score_with_t1_t2: 60", "push_min_score_with_t1_t2: 600");
    const [issue] = failures(text);
    expect(issue).toMatchObject({ source: "schema", path: "push_min_score_high_value", line: 1, col: 1 });
    expect(issue?.message.startsWith("push_min_score_high_value: ")).toBe(true);
  });

  it("an unknown key in an older file is reported at the key the user wrote", () => {
    const text = OLD_NOTIFY.replace("max_per_cycle: 10", "max_per_cycle: 10\nnot_a_key: 1");
    const [issue] = failures(text);
    expect(issue).toMatchObject({ source: "schema", path: "not_a_key", exact: true });
    expect(lineOf(text, issue as TextIssue)).toContain("not_a_key");
  });

  it("is not mutated: validating twice gives the same answer, and the text argument is untouched", () => {
    const first = validateConfigText("notify", OLD_NOTIFY);
    const second = validateConfigText("notify", OLD_NOTIFY);
    expect(first).toEqual(second);
    expect(OLD_NOTIFY).toContain("push_min_score_with_t1_t2");
  });

  it("a file at the current version still gets exact lines, with no path prefix", () => {
    const current = readConfigText("notify").replace("push_min_score: 70", "push_min_score: 700");
    const [issue] = failures(current);
    expect(issue).toMatchObject({ path: "push_min_score", exact: true });
    expect(issue?.line).toBeGreaterThan(1);
    expect(issue?.message.startsWith("push_min_score")).toBe(false);
  });

  it("still refuses a missing or newer config_version", () => {
    const bare = readConfigText("notify").replace(/^config_version: .*\n/m, "");
    expect(failures(bare)[0]).toMatchObject({ source: "version" });
    expect(failures(bare)[0]?.message).toContain("config_version is missing");
    expect(failures(`config_version: 99\n${bare}`)[0]?.message).toContain("newer");
  });
});

describe("saving an older file from the editor", () => {
  const options = () => ({ baseHash: hashConfigText(readConfigText("notify")), baseLayer: configLayer("notify"), maxBytes: 1_000_000, backupsKeep: 3 });

  it("writes the text as written (still the old format), and the loader reads it migrated", async () => {
    await writeConfigText("notify", OLD_NOTIFY, options());
    expect(fs.readFileSync(userFile(), "utf8")).toBe(OLD_NOTIFY);
    expect(loadConfig("notify").push_min_score_high_value).toBe(60);
    // the file on disk was not migrated by the save
    expect(fs.readFileSync(userFile(), "utf8")).toContain("push_min_score_with_t1_t2: 60");
  });

  it("refuses an older file that is invalid after its migration, and leaves the file as it was", async () => {
    const before = fs.readFileSync(userFile(), "utf8");
    const text = OLD_NOTIFY.replace("push_min_score_with_t1_t2: 60", "push_min_score_with_t1_t2: 600");
    await expect(writeConfigText("notify", text, options())).rejects.toMatchObject({ kind: "schema", issues: [expect.objectContaining({ path: "push_min_score_high_value" })] });
    expect(fs.readFileSync(userFile(), "utf8")).toBe(before);
  });
});
