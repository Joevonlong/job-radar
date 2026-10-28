// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ADVANCED_NAMES, advancedNameOfStem, advancedStem, loadAdvancedFile, loadAdvancedIndex } from "@/lib/settings/advanced/view";
import { SLOW_PATTERN_MESSAGE } from "@/lib/config/interests-lint";
import { previewAdvanced, resetAdvanced, saveAdvanced, validateAdvanced } from "@/lib/settings/advanced/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

const userFile = (name: string) => path.join(tmp.configDir, name);
const userText = (name: string) => fs.readFileSync(userFile(name), "utf8");

function opened(stem: string) {
  const loaded = loadAdvancedFile(stem);
  if (!loaded.ok) throw new Error("not loadable");
  return loaded.data;
}

describe("the file list", () => {
  it("lists every layered config file (not the profile files), user configs and product defaults apart", () => {
    const entries = loadAdvancedIndex();
    expect(entries.map((entry) => entry.stem)).toEqual(ADVANCED_NAMES.map(advancedStem));
    expect(entries.map((entry) => entry.stem)).not.toContain("me");
    expect(entries.find((entry) => entry.stem === "sources")?.file).toBe("sources.yaml");
    expect(entries.filter((entry) => entry.group === "shipped").map((entry) => entry.stem).sort()).toEqual(expect.arrayContaining(["models", "pipeline"]));
    expect(entries.find((entry) => entry.stem === "pipeline")).toMatchObject({ layer: "default", overridden: false, valid: true });
    expect(entries.find((entry) => entry.stem === "ai")).toMatchObject({ layer: "user", valid: true, versionBehind: false });
  });

  it("an invalid file shows its first problem; one still on an older version is flagged", () => {
    fs.writeFileSync(userFile("notify.yaml"), `${userText("notify.yaml")}\nbogus: 1\n`);
    fs.writeFileSync(userFile("ui.yaml"), userText("ui.yaml").replace("config_version: 2\n\n", ""));
    const entries = loadAdvancedIndex();
    expect(entries.find((entry) => entry.stem === "notify")).toMatchObject({ valid: false, firstProblem: "bogus: unknown key" });
    expect(entries.find((entry) => entry.stem === "ui")).toMatchObject({ valid: false, versionBehind: true });
  });

  it("accepts the registry name as well as the file stem", () => {
    expect(advancedNameOfStem("sources")).toBe("channels");
    expect(advancedNameOfStem("channels")).toBe("channels");
    expect(advancedNameOfStem("me")).toBeNull();
    expect(advancedNameOfStem("../etc/passwd")).toBeNull();
  });

  it("opens a broken ui.yaml and uses the default limits (the editor must work to repair it)", async () => {
    fs.writeFileSync(userFile("ui.yaml"), "salary_axis: [oops\n");
    const data = opened("ai");
    expect(data.maxBytes).toBeGreaterThan(0);
    expect(opened("ui").text).toBe("salary_axis: [oops\n");
    expect((await validateAdvanced({ file: "ui", text: "salary_axis: [oops\n" })).ok).toBe(false);
  });
});

describe("save", () => {
  it("refuses an interests.yaml pattern that is too slow on the probe's test texts, at its line; the file is unchanged", async () => {
    const data = opened("interests");
    const before = userText("interests.yaml");
    const text = data.text.replace(/(- id: T2\n(?:[ \t]+.*\n)*?([ \t]+)patterns:\n)/, `$1$2  - "(\\\\w+\\\\s*)*budget"\n`);
    expect(text).not.toBe(data.text);
    const live = await validateAdvanced({ file: "interests", text });
    expect(live.ok).toBe(false);
    const result = await saveAdvanced({ file: "interests", text, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(result.status).toBe("invalid");
    if (result.status !== "invalid") return;
    expect(result.issues).toEqual([expect.objectContaining({ path: expect.stringMatching(/^signals\.categories\[\d+\]\.patterns\[0\]$/), message: SLOW_PATTERN_MESSAGE, source: "schema", exact: true })]);
    expect(text.split("\n")[result.issues[0]!.line - 1]).toContain("budget");
    expect(userText("interests.yaml")).toBe(before);
  });

  it("writes the text verbatim, backs the old one up and reports the new hash", async () => {
    const data = opened("notify");
    const text = `${data.text}\n# kept comment\n`;
    const result = await saveAdvanced({ file: "notify", text, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(result).toMatchObject({ status: "saved", layer: "user", backup: true });
    expect(userText("notify.yaml")).toBe(text);
    expect(opened("notify").hash).toBe(result.status === "saved" ? result.hash : "");
  });

  it("refuses text that does not validate and leaves the file", async () => {
    const data = opened("notify");
    const before = userText("notify.yaml");
    const result = await saveAdvanced({ file: "notify", text: `${data.text}\nbogus: 1\n`, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(result).toMatchObject({ status: "invalid" });
    if (result.status === "invalid") expect(result.issues[0]).toMatchObject({ path: "bogus" });
    expect(userText("notify.yaml")).toBe(before);
  });

  it("answers 'stale' with the latest text when the file changed after it was opened", async () => {
    const data = opened("notify");
    const theirs = userText("notify.yaml").replace(/^max_per_cycle: \d+/m, "max_per_cycle: 3");
    fs.writeFileSync(userFile("notify.yaml"), theirs);
    const result = await saveAdvanced({ file: "notify", text: `${data.text}# mine\n`, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(result.status).toBe("stale");
    if (result.status === "stale") expect(result.current.text).toBe(theirs);
    expect(userText("notify.yaml")).toBe(theirs);
  });

  it("a file that moved to another layer since it was opened counts as changed", async () => {
    const data = opened("pipeline");
    fs.writeFileSync(userFile("pipeline.yaml"), data.text);
    const result = await saveAdvanced({ file: "pipeline", text: `${data.text}# mine\n`, baseHash: data.hash, baseLayer: data.layer, confirmOverride: true });
    expect(result.status).toBe("stale");
  });

  it("the first save of a product default file needs the confirmation; then the user directory gets it and only it", async () => {
    const data = opened("pipeline");
    const text = `${data.text}\n# mine\n`;
    expect(await saveAdvanced({ file: "pipeline", text, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false })).toEqual({ status: "needs_confirm" });
    expect(fs.existsSync(userFile("pipeline.yaml"))).toBe(false);
    const result = await saveAdvanced({ file: "pipeline", text, baseHash: data.hash, baseLayer: data.layer, confirmOverride: true });
    expect(result).toMatchObject({ status: "saved", layer: "user", backup: false });
    expect(userText("pipeline.yaml")).toBe(text);
    expect(fs.readFileSync(path.join(tmp.defaultsDir, "pipeline.yaml"), "utf8")).toBe(data.text);
    // saving again does not ask again
    const again = opened("pipeline");
    expect(again.entry.overridden).toBe(true);
    const second = await saveAdvanced({ file: "pipeline", text: `${text}# more\n`, baseHash: again.hash, baseLayer: again.layer, confirmOverride: false });
    expect(second).toMatchObject({ status: "saved" });
  });

  it("rejects malformed requests and unknown files without throwing", async () => {
    expect(await saveAdvanced({ nonsense: true })).toEqual({ status: "failed" });
    expect(await saveAdvanced({ file: "me", text: "a: 1", baseHash: "x", baseLayer: "user", confirmOverride: false })).toEqual({ status: "failed" });
    expect(await saveAdvanced({ file: "notify", text: 5, baseHash: "x", baseLayer: "user", confirmOverride: false })).toEqual({ status: "failed" });
    expect(await validateAdvanced({ file: "nope", text: "" })).toMatchObject({ ok: false });
    expect(await previewAdvanced({ file: "notify", text: "", against: "elsewhere" })).toBeNull();
  });

  it("refuses text above the editor's limit", async () => {
    const data = opened("notify");
    const result = await saveAdvanced({ file: "notify", text: `${data.text}\n${"# x".repeat(100_000)}\n`, baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(result.status).toBe("too_large");
  });
});

describe("restore the default", () => {
  it("a product default file loses its override; a user file gets the default text", async () => {
    const pipeline = opened("pipeline");
    fs.writeFileSync(userFile("pipeline.yaml"), `${pipeline.text}\n# mine\n`);
    let state = opened("pipeline");
    expect(state.canReset).toBe(true);
    expect(await resetAdvanced({ file: "pipeline", baseHash: state.hash, baseLayer: state.layer })).toMatchObject({ status: "reset", layer: "default", backup: true });
    expect(fs.existsSync(userFile("pipeline.yaml"))).toBe(false);

    fs.writeFileSync(userFile("notify.yaml"), userText("notify.yaml").replace(/^max_per_cycle: \d+/m, "max_per_cycle: 2"));
    state = opened("notify");
    expect(state.canReset).toBe(true);
    await resetAdvanced({ file: "notify", baseHash: state.hash, baseLayer: state.layer });
    expect(userText("notify.yaml")).toBe(fs.readFileSync(path.join(tmp.defaultsDir, "notify.yaml"), "utf8"));
    expect(opened("notify").canReset).toBe(false);
  });

  it("refuses when the file changed since it was opened", async () => {
    const state = opened("notify");
    fs.writeFileSync(userFile("notify.yaml"), `${userText("notify.yaml")}# changed\n`);
    expect((await resetAdvanced({ file: "notify", baseHash: state.hash, baseLayer: state.layer })).status).toBe("stale");
  });
});

describe("preview", () => {
  it("diffs against the saved text and against the product default; 'no change' is empty", async () => {
    const data = opened("notify");
    const edited = data.text.replace(/^max_per_cycle: \d+/m, "max_per_cycle: 8");
    const saved = await previewAdvanced({ file: "notify", text: edited, against: "saved" });
    expect(saved?.changed).toBe(true);
    expect(saved?.paths).toEqual(["max_per_cycle"]);
    expect(saved?.lines.some((line) => line.type === "add" && line.text === "max_per_cycle: 8")).toBe(true);
    expect((await previewAdvanced({ file: "notify", text: data.text, against: "saved" }))?.changed).toBe(false);
    expect((await previewAdvanced({ file: "notify", text: data.text, against: "default" }))?.changed).toBe(false);
  });

  it("reports a change made behind the editor's back at preview, not only at save", async () => {
    const data = opened("notify");
    const edited = data.text.replace(/^max_per_cycle: \d+/m, "max_per_cycle: 8");
    expect((await previewAdvanced({ file: "notify", text: edited, against: "saved", baseHash: data.hash, baseLayer: data.layer }))?.stale).toBeNull();
    fs.writeFileSync(userFile("notify.yaml"), `${userText("notify.yaml")}# changed\n`);
    const preview = await previewAdvanced({ file: "notify", text: edited, against: "saved", baseHash: data.hash, baseLayer: data.layer });
    expect(preview?.stale?.text).toContain("# changed");
    expect(preview?.changed).toBe(false);
  });

  it("never shows a proxy's credentials in a diff", async () => {
    const withProxy = userText("sources.yaml").replace("proxies: []", 'proxies:\n    - "http://alice:s3cret@proxy.example:8080"');
    fs.writeFileSync(userFile("sources.yaml"), withProxy);
    const data = opened("sources");
    expect(data.text).not.toContain("s3cret");
    const preview = await previewAdvanced({ file: "sources", text: data.text.replace(/timeout_ms: (\d+)/, "timeout_ms: 4321"), against: "saved" });
    expect(JSON.stringify(preview)).not.toContain("s3cret");
    // saving what the editor shows keeps the real proxy; a different one is refused
    const kept = await saveAdvanced({ file: "sources", text: data.text.replace(/timeout_ms: (\d+)/, "timeout_ms: 4321"), baseHash: data.hash, baseLayer: data.layer, confirmOverride: false });
    expect(kept.status).toBe("saved");
    expect(userText("sources.yaml")).toContain("alice:s3cret@proxy.example:8080");
    const next = opened("sources");
    const refused = await saveAdvanced({ file: "sources", text: next.text.replace("proxy.example", "elsewhere.example"), baseHash: next.hash, baseLayer: next.layer, confirmOverride: false });
    expect(refused).toEqual({ status: "proxies_changed" });
    expect(userText("sources.yaml")).toContain("proxy.example:8080");
  });
});
