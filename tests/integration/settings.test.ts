import fs from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { getConfigPath, hashConfigText, loadConfig, readConfigText, resolveConfigPath, watchConfig } from "@/lib/config";
import { claimNextControlRequest, closeDb, createCycle, createRun, finishRun, getDb, insertControlRequest, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { ackState, diskConfigHash, readConfigAcks, recordAllConfigLoaded, recordConfigLoaded } from "@/lib/settings/ack";
import { configToDraft } from "@/lib/settings/draft";
import { saveSettings } from "@/lib/settings/service";
import { loadControlStatus } from "@/lib/settings/status";
import { ACK_NAMES, SETTINGS_FORMS, isAckName, type AckName, type SettingsForm } from "@/lib/settings/tabs";
import { loadSettingsPage } from "@/lib/settings/view";

import { makeTempConfig, sleep, type TempConfig } from "../config/helpers";

const url = inject("testDatabaseUrl");
let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  temp = makeTempConfig();
  await getDb().execute(sql`truncate table control_requests, runtime_state, runner_heartbeats, scores, runs, cycles, channels restart identity cascade`);
});

afterEach(() => temp.cleanup());

afterAll(async () => {
  await closeDb();
});

// The file in use (models.yaml is read from the defaults until a test writes an override)
const read = (tab: SettingsForm | "models") => fs.readFileSync(resolveConfigPath(tab), "utf8");

/** A save as the form makes it: with the hash of the file as it is now. */
const saveNow = (request: { tab: SettingsForm; draft: Record<string, unknown> }) => saveSettings({ ...request, baseHash: hashConfigText(read(request.tab)) });

function draftOf(tab: SettingsForm) {
  return configToDraft(tab, loadConfig(tab));
}

describe("saveSettings", () => {
  it("changes a search keyword: the YAML is updated, its comments stay, the new value loads", async () => {
    const draft = draftOf("search");
    const groups = draft.keyword_groups as Array<{ id: string; keywords: string[] }>;
    groups[0]?.keywords.push("Agent Developer");
    draft["window_hours.morning"] = "30";
    const before = read("search");
    expect(before).toContain("# 工程类");

    const result = await saveNow({ tab: "search", draft });
    expect(result).toMatchObject({ status: "saved", tab: "search" });

    const after = read("search");
    expect(after).toContain("Agent Developer");
    expect(after).toContain("morning: 30");
    expect(after).toContain("# 工程类");
    expect(after).toContain("# 搜索条件");
    expect(after.split("\n").length).toBeGreaterThanOrEqual(before.split("\n").length);
    const reloaded = loadConfig("search");
    expect(reloaded.keyword_groups.engineering).toContain("Agent Developer");
    expect(reloaded.window_hours.morning).toBe(30);
  });

  it("refuses a save made on an older version of the file (another tab or device saved in between)", async () => {
    const opened = hashConfigText(read("search"));
    const first = draftOf("search");
    first["window_hours.morning"] = "31";
    expect(await saveSettings({ tab: "search", draft: first, baseHash: opened })).toMatchObject({ status: "saved" });
    const afterFirst = read("search");
    const second = draftOf("search");
    second["window_hours.morning"] = "32";
    const result = await saveSettings({ tab: "search", draft: second, baseHash: opened });
    expect(result).toMatchObject({ status: "error", tab: "search", formError: "stale", baseHash: hashConfigText(afterFirst) });
    expect(read("search")).toBe(afterFirst);
    // with the current version it saves
    expect(await saveSettings({ tab: "search", draft: second, baseHash: hashConfigText(afterFirst) })).toMatchObject({ status: "saved" });
  });

  it("an invalid value comes back as a field error and leaves the file untouched", async () => {
    const before = read("schedule");
    const draft = draftOf("schedule");
    draft["cycles.weekday_morning.cron"] = "not a cron";
    draft.timezone = "Nowhere/Land";
    const result = await saveNow({ tab: "schedule", draft });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.formError).toBeNull();
    expect(result.baseHash).toBe(hashConfigText(before));
    expect(result.fieldErrors.map((e) => `${e.path}:${e.key}`).sort()).toEqual(["cycles.weekday_morning.cron:cron", "timezone:timezone"]);
    expect(read("schedule")).toBe(before);
  });

  it("rejects what is not a settings draft, and a file that cannot be read", async () => {
    expect(await saveSettings({ tab: "nope", draft: {} })).toMatchObject({ status: "error", formError: "invalidPayload" });
    expect(await saveSettings({ tab: "search", draft: { locations: 5 } })).toMatchObject({ status: "error", tab: "search", formError: "invalidPayload" });
    expect(await saveSettings("search")).toMatchObject({ status: "error", formError: "invalidPayload" });
    // the form always sends the hash it was opened on; a save without one is refused
    expect(await saveSettings({ tab: "search", draft: draftOf("search") })).toMatchObject({ status: "error", tab: "search", formError: "invalidPayload" });
    const draft = draftOf("notify");
    fs.writeFileSync(getConfigPath("notify"), "push_min_score: [oops\n");
    expect(await saveNow({ tab: "notify", draft })).toMatchObject({ status: "error", tab: "notify", formError: "unreadable" });
    expect(read("notify")).toBe("push_min_score: [oops\n");
  });

  it("keeps the keys the form does not show, such as the jobspy proxy list", async () => {
    const draft = draftOf("channels");
    const text = read("channels").replace("proxies: []", 'proxies: ["http://user:secret@proxy.example.test:8080"]');
    fs.writeFileSync(getConfigPath("channels"), text);
    draft["sources.indeed.enabled"] = false;
    expect(await saveNow({ tab: "channels", draft })).toMatchObject({ status: "saved" });
    expect(read("channels")).toContain("secret@proxy.example.test");
    expect(read("channels")).toContain("# 代理列表");
    expect(loadConfig("channels").sources.indeed.enabled).toBe(false);
  });

  it("saves every tab from an untouched draft without changing what the file means", async () => {
    for (const tab of SETTINGS_FORMS) {
      const before = loadConfig(tab);
      expect(await saveNow({ tab, draft: draftOf(tab) }), tab).toMatchObject({ status: "saved" });
      expect(loadConfig(tab)).toEqual(before);
    }
  });

  it("the AI tab saves a task's model into ai.yaml with its comments, and refuses what the catalog does not know", async () => {
    const draft = draftOf("ai");
    draft["tasks.translate"] = [{ provider: "codex-cli", model: "" }, { provider: "claude-cli", model: "claude-sonnet-5-5" }, { provider: "api", model: "" }];
    draft["providers.claude_cli.model"] = "claude-opus-5-5";
    expect(await saveNow({ tab: "ai", draft })).toMatchObject({ status: "saved" });
    const after = read("ai");
    expect(loadConfig("ai").tasks.translate).toEqual({ order: ["codex-cli", "claude-cli", "api"], models: { "claude-cli": "claude-sonnet-5-5" } });
    expect(loadConfig("ai").providers.claude_cli.model).toBe("claude-opus-5-5");
    expect(after).toContain("# 宿主机 ai-worker");
    // the form never writes the legacy keys back (the shipped ai.yaml is migrated: phase 2 of the model catalog)
    expect(after).not.toMatch(/^pricing:/m);

    const bad = draftOf("ai");
    bad["providers.deepseek.model"] = "deepseek-gone";
    bad["tasks.translate"] = [{ provider: "claude-cli", model: "claude-nope" }];
    const text = read("ai");
    const result = await saveNow({ tab: "ai", draft: bad });
    expect(result).toMatchObject({ status: "error", tab: "ai", formError: null });
    if (result.status === "error") {
      expect(result.fieldErrors).toEqual([
        { path: "providers.deepseek.model", key: "modelNotInCatalog", params: { model: "deepseek-gone" } },
        { path: "tasks.translate", key: "modelNotInCatalog", params: { model: "claude-nope" } },
      ]);
    }
    expect(read("ai")).toBe(text);
  });

  it("a codex effort the model does not support is refused on its field", async () => {
    const models = read("models");
    fs.writeFileSync(getConfigPath("models"), models.replace("cli_default: true", "cli_default: true\n        reasoning_efforts: [medium, high]"));
    const draft = draftOf("ai");
    const result = await saveNow({ tab: "ai", draft });
    expect(result).toMatchObject({ status: "error", fieldErrors: [{ path: "providers.codex_cli.reasoning_effort", key: "effortUnsupported" }] });
    draft["providers.codex_cli.reasoning_effort"] = "high";
    expect(await saveNow({ tab: "ai", draft })).toMatchObject({ status: "saved" });
  });

  it("every tab names the user file it saves to; the AI tab names the models.yaml in use", async () => {
    const page = await loadSettingsPage();
    // the web shows the conventional short path, not the machine's absolute one
    for (const section of page.sections) expect(section.file).toBe(path.join("data", "config", path.basename(getConfigPath(section.tab))));
    expect(page.sections.find((section) => section.tab === "ai")?.catalogFile).toBe(path.join("config", "models.yaml"));
  });

  it("a broken models.yaml makes the AI tab unsavable and shows up on the page, other tabs are unaffected", async () => {
    // A broken user override of the shipped models.yaml
    const good = read("models");
    fs.writeFileSync(getConfigPath("models"), good.replace(/\n\s+price: \{ input_per_mtok: 1, output_per_mtok: 3 \}/, ""));
    const ai = read("ai");
    expect(await saveNow({ tab: "ai", draft: draftOf("ai") })).toMatchObject({ status: "error", formError: "catalogUnreadable" });
    expect(read("ai")).toBe(ai);
    const page = await loadSettingsPage();
    expect(page.catalog).toBeNull();
    expect(page.catalogError).toContain("providers.mimo.models[0].price");
    expect(page.sections.find((section) => section.tab === "ai")?.catalogFile).toBe(path.join("data", "config", "models.yaml"));
    expect(await saveNow({ tab: "search", draft: draftOf("search") })).toMatchObject({ status: "saved" });
    // fixed: the file is read fresh on the next request
    fs.writeFileSync(getConfigPath("models"), good);
    const fixed = await loadSettingsPage();
    expect(fixed.catalogError).toBeNull();
    expect(fixed.catalog?.providers.mimo.models[0]?.price).toEqual({ input: 1, output: 3 });
  });

  it("the page loader hands each tab its draft and hash, and reports a broken file", async () => {
    let page = await loadSettingsPage();
    expect(page.sections.map((s) => s.tab)).toEqual([...SETTINGS_FORMS]);
    expect(page.sections.every((s) => s.draft !== null && s.hash === hashConfigText(read(s.tab)))).toBe(true);
    expect(page.channelChoices).toContain("indeed");
    expect(page.channelChoices).toContain("linkedin-apify"); // registered now
    expect(page.channelChoices).not.toContain("linkedin-session");
    expect(page.status).not.toBeNull();

    fs.writeFileSync(getConfigPath("ai"), "order: [claude-cli\n");
    page = await loadSettingsPage();
    const ai = page.sections.find((s) => s.tab === "ai");
    expect(ai?.draft).toBeNull();
    expect(ai?.loadError).toMatch(/not valid YAML/);
  });
});

describe("hot reload acknowledgement", () => {
  it("is loaded once the runner reports the text that is on disk", async () => {
    const db = getDb();
    expect(await loadControlStatus(db)).toMatchObject({ acks: { schedule: { state: "unknown", loadedAt: null } } });

    expect(await recordAllConfigLoaded(db)).toEqual([...ACK_NAMES]);
    let status = await loadControlStatus(db);
    for (const tab of ACK_NAMES) expect(status.acks[tab], tab).toMatchObject({ state: "loaded" });
    expect(status.acks.search?.loadedAt).not.toBeNull();

    await saveNow({ tab: "search", draft: { ...draftOf("search"), max_per_group_per_location: "30" } });
    status = await loadControlStatus(db);
    expect(status.acks.search?.state).toBe("waiting");
    expect(status.acks.schedule?.state).toBe("loaded");

    await recordConfigLoaded(db, "search", readConfigText("search"));
    status = await loadControlStatus(db);
    expect(status.acks.search?.state).toBe("loaded");
    expect(ackState(diskConfigHash("search"), (await readConfigAcks(db)).search)).toBe("loaded");
  });

  it("follows a save through the config watcher, the way the runner does it", async () => {
    const db = getDb();
    await recordAllConfigLoaded(db);
    const stop = watchConfig(
      [...ACK_NAMES],
      (event) => {
        if (isAckName(event.name)) void recordConfigLoaded(db, event.name satisfies AckName, event.text);
      },
      { pollMs: 50, debounceMs: 20 },
    );
    try {
      // an edit made behind the form's back counts too
      const text = read("notify").replace("max_per_cycle: 10", "max_per_cycle: 12");
      fs.writeFileSync(getConfigPath("notify"), text);
      let state = "";
      for (let i = 0; i < 60 && state !== "loaded"; i += 1) {
        await sleep(50);
        state = (await loadControlStatus(db)).acks.notify?.state ?? "unknown";
      }
      expect(state).toBe("loaded");
      expect(loadConfig("notify").max_per_cycle).toBe(12);
    } finally {
      stop();
    }
  });
});

describe("control status", () => {
  it("lists recent requests with their outcome and the progress of the cycle they started", async () => {
    const db = getDb();
    const done = await insertControlRequest(db, { kind: "rescore_stale" });
    await db.update(schema.controlRequests).set({ status: "done", result: { scored: 0, failed: 0, placeholder: true }, finishedAt: new Date() }).where(sql`id = ${done.id}`);

    const run = await insertControlRequest(db, { kind: "run_cycle", payload: { channelIds: ["indeed"] } });
    await claimNextControlRequest(db);
    await db.insert(schema.channels).values({ id: "indeed", family: "indeed", kind: "api" });
    const cycle = await createCycle(db, { kind: "manual" });
    const first = await createRun(db, { channelId: "indeed", cycleId: cycle.id });
    await finishRun(db, first.id, { status: "succeeded", fetched: 12, newCount: 4 });
    await createRun(db, { channelId: "indeed", cycleId: cycle.id });

    const status = await loadControlStatus(db);
    expect(status.requests.map((r) => r.id)).toEqual([run.id, done.id]);
    expect(status.requests[0]).toMatchObject({ kind: "run_cycle", status: "running", channelIds: ["indeed"], cycle: { id: cycle.id, status: "running", runsTotal: 2, runsFinished: 1, fetched: 12, newCount: 4 } });
    expect(status.requests[1]).toMatchObject({ kind: "rescore_stale", status: "done", placeholder: true, scored: 0, failed: 0, cycle: null });
    expect(status.heartbeat).toEqual({ at: null, ageSeconds: null, online: false });
    expect(status.staleScores).toBe(0);
  });

  it("reports the runner as online after a fresh heartbeat", async () => {
    const db = getDb();
    await db.insert(schema.runnerHeartbeats).values({ process: "runner" });
    const status = await loadControlStatus(db);
    expect(status.heartbeat.online).toBe(true);
    expect(status.heartbeat.ageSeconds).toBeLessThan(5);
  });
});
