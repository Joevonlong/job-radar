// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, parseDocument } from "yaml";

import { loadConfig, resetConfigCache } from "@/lib/config";
import { applySourcesImport, enableMarketChannels, exportSources, previewSourcesImport, removeAtsBoard, saveAtsBoard, setSourceEnabled } from "@/lib/sources/registry/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const sync = vi.hoisted(() => ({ syncSourceRegistry: vi.fn(async () => ({ upserted: 0, removed: 0 })) }));
vi.mock("@/lib/sources/registry/sync", () => sync);
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

let tmp: TempConfig;
const file = (): string => path.join(tmp.configDir, "sources.yaml");
const text = (): string => fs.readFileSync(file(), "utf8");

beforeEach(() => {
  tmp = makeTempConfig();
  sync.syncSourceRegistry.mockClear();
});
afterEach(() => tmp.cleanup());

/** Put keys of the temp sources.yaml where this test needs them (comments stay): the test never relies on what the shipped file says. */
function setKeys(values: Record<string, unknown>): void {
  const doc = parseDocument(text());
  for (const [key, value] of Object.entries(values)) doc.setIn(key.split("."), value);
  fs.writeFileSync(file(), String(doc));
  resetConfigCache();
}

/** Lines that differ between two texts (same line count assumed). */
function changedLines(before: string, after: string): Array<[string, string]> {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b).toHaveLength(a.length);
  return a.flatMap((line, i): Array<[string, string]> => (line === b[i] ? [] : [[line, b[i] ?? ""]]));
}

describe("setSourceEnabled", () => {
  it("changes only the enabled value of a channel, keeps every comment, and mirrors the file", async () => {
    const before = text();
    expect(await setSourceEnabled({ id: "indeed", enabled: false })).toEqual({ status: "done", outcome: "disabled" });
    const diff = changedLines(before, text());
    expect(diff).toHaveLength(1);
    expect(diff[0]?.[0]).toMatch(/enabled: true/);
    expect(diff[0]?.[1]).toMatch(/enabled: false/);
    expect(text()).toContain("# 熔断：连续失败 failures 次后");
    expect(loadConfig("channels").sources.indeed.enabled).toBe(false);
    expect(sync.syncSourceRegistry).toHaveBeenCalledTimes(1);
    expect(await setSourceEnabled({ id: "indeed", enabled: true })).toEqual({ status: "error", error: "consent_required" });
    expect(await setSourceEnabled({ id: "indeed", enabled: true, acknowledged: true })).toEqual({ status: "done", outcome: "enabled" });
    expect(text()).toBe(before);
  });

  it("writes linkedin.session.recommended_daily for the recommended channel and leaves the session alone", async () => {
    setKeys({ "linkedin.session.enabled": true, "linkedin.session.recommended_daily": true });
    expect(await setSourceEnabled({ id: "linkedin-session:recommended", enabled: false })).toEqual({ status: "done", outcome: "disabled" });
    expect(loadConfig("channels").linkedin.session).toMatchObject({ recommended_daily: false, enabled: true });
    expect(await setSourceEnabled({ id: "linkedin-session:recommended", enabled: true, acknowledged: true })).toEqual({ status: "done", outcome: "enabled" });
    expect(loadConfig("channels").linkedin.session.recommended_daily).toBe(true);
  });

  it("does not claim to enable the recommended read while linkedin-session is off: it refuses and writes nothing", async () => {
    setKeys({ "linkedin.session.enabled": false, "linkedin.session.recommended_daily": true });
    const before = text();
    expect(await setSourceEnabled({ id: "linkedin-session:recommended", enabled: true, acknowledged: true })).toEqual({ status: "error", error: "needs_parent" });
    expect(text()).toBe(before);
    expect(sync.syncSourceRegistry).not.toHaveBeenCalled();
    // switching it off still writes its own key
    setKeys({ "linkedin.session.recommended_daily": true });
    expect(await setSourceEnabled({ id: "linkedin-session:recommended", enabled: false })).toEqual({ status: "done", outcome: "disabled" });
    expect(loadConfig("channels").linkedin.session.recommended_daily).toBe(false);
  });

  it("switches a board with one line changed", async () => {
    const before = text();
    expect(await setSourceEnabled({ id: "board:greenhouse:zellwerk", enabled: false })).toEqual({ status: "done", outcome: "disabled" });
    const diff = changedLines(before, text());
    expect(diff).toHaveLength(1);
    expect(diff[0]?.[1]).toBe('  - { name: "Zellwerk", ats: greenhouse, token: "zellwerk", enabled: false }');
    expect(loadConfig("channels").ats_boards.find((b) => b.token === "zellwerk")?.enabled).toBe(false);
  });

  it("refuses bad input and unknown entries without writing", async () => {
    const before = text();
    expect(await setSourceEnabled({ id: "", enabled: true })).toEqual({ status: "error", error: "invalid" });
    expect(await setSourceEnabled({ id: "indeed", enabled: "yes" })).toEqual({ status: "error", error: "invalid" });
    expect(await setSourceEnabled({ id: "board:greenhouse:nope", enabled: true })).toEqual({ status: "error", error: "unknown_entry" });
    expect(text()).toBe(before);
    expect(sync.syncSourceRegistry).not.toHaveBeenCalled();
  });
});

describe("enableMarketChannels", () => {
  it("switches on the listed channels that are off in one write, leaves the rest, and says when nothing changes", async () => {
    setKeys({ "sources.arbeitsagentur.enabled": false, "sources.greenhouse.enabled": false, "sources.lever.enabled": false });
    expect(await enableMarketChannels(["arbeitsagentur", "greenhouse", "unknown-channel"])).toEqual({ status: "done", outcome: "enabled" });
    const sources = loadConfig("channels").sources;
    expect([sources.arbeitsagentur.enabled, sources.greenhouse.enabled, sources.lever.enabled]).toEqual([true, true, false]);
    expect(sync.syncSourceRegistry).toHaveBeenCalledTimes(1);
    const before = text();
    expect(await enableMarketChannels(["arbeitsagentur", "greenhouse"])).toEqual({ status: "error", error: "no_changes" });
    expect(text()).toBe(before);
  });

  it("never switches on a channel with a terms-of-service risk in bulk", async () => {
    setKeys({ "sources.stepstone.enabled": false, "sources.xing.enabled": false, "sources.indeed.enabled": false });
    const before = text();
    expect(await enableMarketChannels(["stepstone", "xing", "indeed"])).toEqual({ status: "error", error: "no_changes", skipped: ["indeed", "stepstone", "xing"] });
    expect(text()).toBe(before);
  });

  it("reports the skipped channels next to the ones it switched on", async () => {
    setKeys({ "sources.arbeitsagentur.enabled": false, "sources.stepstone.enabled": false });
    expect(await enableMarketChannels(["arbeitsagentur", "stepstone"])).toEqual({ status: "done", outcome: "enabled", skipped: ["stepstone"] });
    const sources = loadConfig("channels").sources;
    expect([sources.arbeitsagentur.enabled, sources.stepstone.enabled]).toEqual([true, false]);
  });
});

describe("boards", () => {
  const board = { name: "Newco", ats: "ashby", token: "newco", enabled: true };

  it("adds, edits and removes a board", async () => {
    const count = loadConfig("channels").ats_boards.length;
    expect(await saveAtsBoard({ original: null, board })).toEqual({ status: "done", outcome: "board_added" });
    expect(loadConfig("channels").ats_boards.at(-1)).toEqual(board);
    // the new entry is written like its neighbours: one flow line
    expect(text()).toContain("  - { name: Newco, ats: ashby, token: newco, enabled: true }\n");
    expect(await saveAtsBoard({ original: { ats: "ashby", token: "newco" }, board: { ...board, name: "Newco AI", token: "newco2", enabled: false } })).toEqual({ status: "done", outcome: "board_updated" });
    expect(loadConfig("channels").ats_boards.at(-1)).toMatchObject({ name: "Newco AI", token: "newco2", enabled: false });
    expect(await removeAtsBoard({ ats: "ashby", token: "newco2" })).toEqual({ status: "done", outcome: "board_removed" });
    expect(loadConfig("channels").ats_boards).toHaveLength(count);
    expect(text()).toContain("# ATS 公司清单");
    expect(sync.syncSourceRegistry).toHaveBeenCalledTimes(3);
  });

  it("returns field errors for a bad token, a duplicate and an EU board outside Lever", async () => {
    const bad = await saveAtsBoard({ original: null, board: { ...board, token: "has space" } });
    expect(bad).toMatchObject({ status: "error", error: "invalid", fieldErrors: [{ path: "token" }] });
    const dup = await saveAtsBoard({ original: null, board: { name: "Zellwerk 2", ats: "greenhouse", token: "ZELLWERK", enabled: true } });
    expect(dup).toMatchObject({ status: "error", error: "invalid", fieldErrors: [{ path: "token", message: "duplicate ats + token" }] });
    const eu = await saveAtsBoard({ original: null, board: { ...board, region: "eu" } });
    expect(eu).toMatchObject({ status: "error", error: "invalid", fieldErrors: [{ path: "region" }] });
    const empty = await saveAtsBoard({ original: null, board: { ...board, name: "  " } });
    expect(empty).toMatchObject({ status: "error", fieldErrors: [{ path: "name" }] });
    expect(await saveAtsBoard({ original: { ats: "ashby", token: "ghost" }, board })).toEqual({ status: "error", error: "unknown_entry" });
    expect(await removeAtsBoard({ ats: "ashby", token: "ghost" })).toEqual({ status: "error", error: "unknown_entry" });
  });

  it("does not write region: global for a board that never had one", async () => {
    await saveAtsBoard({ original: null, board: { name: "Levco", ats: "lever", token: "levco", enabled: true, region: "global" } });
    expect(loadConfig("channels").ats_boards.at(-1)).toEqual({ name: "Levco", ats: "lever", token: "levco", enabled: true });
  });
});

describe("import", () => {
  const edited = (change: (raw: Record<string, unknown>) => void): string => {
    const raw = parse(text()) as Record<string, unknown>;
    change(raw);
    return JSON.stringify(raw);
  };

  it("previews, then applies a file that switches indeed off", async () => {
    const body = edited((raw) => ((raw.sources as { indeed: { enabled: boolean } }).indeed.enabled = false));
    const preview = await previewSourcesImport({ text: body, format: "json", mode: "replace" });
    expect(preview).toMatchObject({ status: "preview", noChanges: false, summary: { channelsDisabled: 1 } });
    if (preview.status !== "preview") throw new Error("no preview");
    expect(await applySourcesImport({ text: body, format: "json", mode: "replace", baseHash: preview.baseHash })).toEqual({ status: "done", outcome: "imported" });
    expect(loadConfig("channels").sources.indeed.enabled).toBe(false);
    expect(text()).toContain("# 熔断：连续失败 failures 次后");
  });

  it("an import that switches a scraping channel on lists it in the preview and needs the acknowledgement to apply", async () => {
    await setSourceEnabled({ id: "indeed", enabled: false });
    const body = edited((raw) => ((raw.sources as { indeed: { enabled: boolean } }).indeed.enabled = true));
    const preview = await previewSourcesImport({ text: body, format: "json", mode: "replace" });
    expect(preview).toMatchObject({ status: "preview", consentChannels: [{ id: "indeed", kind: "scraping" }] });
    if (preview.status !== "preview") throw new Error("no preview");
    const request = { text: body, format: "json", mode: "replace", baseHash: preview.baseHash } as const;
    expect(await applySourcesImport(request)).toEqual({ status: "error", error: "consent_required" });
    expect(await applySourcesImport({ ...request, acknowledged: false })).toEqual({ status: "error", error: "consent_required" });
    expect(loadConfig("channels").sources.indeed.enabled).toBe(false);
    expect(await applySourcesImport({ ...request, acknowledged: true })).toEqual({ status: "done", outcome: "imported" });
    expect(loadConfig("channels").sources.indeed.enabled).toBe(true);
  });

  it("an import that only switches scraping channels off, or changes other things, needs no acknowledgement", async () => {
    const body = edited((raw) => ((raw.sources as { indeed: { enabled: boolean } }).indeed.enabled = false));
    const preview = await previewSourcesImport({ text: body, format: "json", mode: "replace" });
    expect(preview).toMatchObject({ status: "preview", consentChannels: [] });
  });

  it("refuses to apply when the file changed after the preview", async () => {
    const body = edited((raw) => ((raw.sources as { indeed: { enabled: boolean } }).indeed.enabled = false));
    const preview = await previewSourcesImport({ text: body, format: "json", mode: "replace" });
    if (preview.status !== "preview") throw new Error("no preview");
    await setSourceEnabled({ id: "stepstone", enabled: false });
    expect(await applySourcesImport({ text: body, format: "json", mode: "replace", baseHash: preview.baseHash })).toEqual({ status: "error", error: "stale" });
  });

  it("reports the errors of a broken file and applies nothing; an identical file has no changes", async () => {
    expect(await previewSourcesImport({ text: "{nope", format: "json", mode: "replace" })).toMatchObject({ status: "error", error: "invalid" });
    const same = await previewSourcesImport({ text: text(), format: "yaml", mode: "replace" });
    expect(same).toMatchObject({ status: "preview", noChanges: true });
    if (same.status !== "preview") throw new Error("no preview");
    expect(await applySourcesImport({ text: text(), format: "yaml", mode: "replace", baseHash: same.baseHash })).toEqual({ status: "error", error: "no_changes" });
    const huge = await previewSourcesImport({ text: "x".repeat(600_000), format: "yaml", mode: "replace" });
    expect(huge).toMatchObject({ status: "error", issues: [{ message: expect.stringContaining("too large") }] });
  });

  it("merges the companies of an old companies.yaml", async () => {
    const legacy = "companies:\n  - { name: Newco, ats: ashby, token: newco, enabled: true }\n";
    const preview = await previewSourcesImport({ text: legacy, format: "yaml", mode: "merge_boards" });
    expect(preview).toMatchObject({ status: "preview", summary: { boardsAdded: 1, boardsRemoved: 0 } });
    if (preview.status !== "preview") throw new Error("no preview");
    await applySourcesImport({ text: legacy, format: "yaml", mode: "merge_boards", baseHash: preview.baseHash });
    expect(loadConfig("channels").ats_boards.some((b) => b.token === "newco")).toBe(true);
  });

  it("repairs an unreadable sources.yaml with a complete file and keeps its proxy list", async () => {
    const good = text();
    fs.writeFileSync(file(), good.replace("jobspy:", "jobspy:\n  proxies: [\"http://u:p@h:1\"]\n  unknown_key: 1\n#").replace("paid_total_monthly_budget_usd: 15", "paid_total_monthly_budget_usd: oops"));
    resetConfigCache();
    const preview = await previewSourcesImport({ text: good, format: "yaml", mode: "replace" });
    expect(preview).toMatchObject({ status: "preview", noChanges: false });
    if (preview.status !== "preview") throw new Error("no preview");
    expect(await applySourcesImport({ text: good, format: "yaml", mode: "replace", baseHash: preview.baseHash })).toEqual({ status: "done", outcome: "imported" });
    expect(loadConfig("channels").paid_total_monthly_budget_usd).toBe(15);
  });
});

describe("export", () => {
  const options = { now: new Date("2026-10-08T12:02:00Z"), timeZone: "Europe/Berlin" };

  it("exports the file text and the values, named with the local time, credentials masked", async () => {
    fs.writeFileSync(file(), text().replace(/^jobspy:\n/m, 'jobspy:\n  proxies: ["http://user:pw@proxy.example:8080"]\n').replace(/^  proxies: \[\],?\n/m, ""));
    resetConfigCache();
    const yaml = exportSources("yaml", options);
    if ("error" in yaml) throw new Error(yaml.error);
    expect(yaml.filename).toBe("sources-20261008-1402.yaml");
    expect(yaml.body).toContain("# 来源清单：");
    expect(yaml.body).not.toContain("user:pw");
    expect(yaml.body).toContain("***:***@proxy.example");
    const json = exportSources("json", options);
    if ("error" in json) throw new Error(json.error);
    expect(json.filename).toBe("sources-20261008-1402.json");
    expect(json.body).not.toContain("user:pw");
    expect((JSON.parse(json.body) as { ats_boards: unknown[] }).ats_boards).toHaveLength(103);
  });

  it("re-importing the JSON export changes nothing", async () => {
    const json = exportSources("json", options);
    if ("error" in json) throw new Error(json.error);
    expect(await previewSourcesImport({ text: json.body, format: "json", mode: "replace" })).toMatchObject({ status: "preview", noChanges: true });
  });

  it("gives the YAML back even when the file is invalid, and no JSON", () => {
    fs.writeFileSync(file(), "ats_boards: nope\n");
    resetConfigCache();
    expect(exportSources("yaml", options)).toMatchObject({ body: "ats_boards: nope\n" });
    expect(exportSources("json", options)).toEqual({ error: "config_invalid" });
  });
});
