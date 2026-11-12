import fs from "node:fs";
import path from "node:path";
import { stringify } from "yaml";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));

import { loadActivityDetail, loadActivityList } from "@/lib/activity/load";
import { loadAiUsageCsvRows, loadAiUsagePage } from "@/lib/ai-usage/load";
import { loadConfig, resetConfigCache } from "@/lib/config";
import { closeDb, getDb, schema } from "@/lib/db";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { activityEvent, activityRow } from "./activity-helpers";

const at = new Date("2026-03-12T12:00:00Z");
let temp: TempConfig;
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
beforeEach(() => {
  temp = makeTempConfig();
  const activity = loadConfig("activityLog");
  fs.writeFileSync(path.join(temp.configDir, "activity-log.yaml"), stringify({ ...activity, ui: { ...activity.ui, page_size: 1, events_page_size: 1 } }));
  const ui = loadConfig("ui");
  fs.writeFileSync(path.join(temp.configDir, "ui.yaml"), stringify({ ...ui, ai_usage: { ...ui.ai_usage, log_page_size: 1, csv_max_rows: 2 } }));
  const schedule = loadConfig("schedule");
  fs.writeFileSync(path.join(temp.configDir, "schedule.yaml"), stringify({ ...schedule, timezone: "UTC" }));
  resetConfigCache();
});
afterEach(() => temp.cleanup());
afterAll(() => closeDb());

it("keeps activity filtering, date boundaries, page clamping and detail event paging", async () => {
  const first = activityRow({ status: "ok", startedAt: at, finishedAt: at, lastActivityAt: at });
  const second = activityRow({ scope: "request", name: "request.translate_job", status: "failed", startedAt: new Date(at.getTime() + 1000), finishedAt: at, lastActivityAt: at });
  await getDb().insert(schema.activitySpans).values([first, second]);
  await getDb().insert(schema.activityEvents).values([activityEvent(second, { level: "error", code: "item.failed" }), activityEvent(second, { level: "info", code: "item.ok" })]);
  const params = { range: "custom", from: "2026-03-12", to: "2026-03-12", page: "99" };
  const list = await loadActivityList(Promise.resolve(params));
  expect(list.state).toBe("ready");
  if (list.state !== "ready") throw new Error("list unavailable");
  expect(list.total).toBe(2);
  expect(list.url.page).toBe(2);
  expect(list.rows.map((row) => row.id)).toEqual([first.id]);
  expect(list.range.fromInstant.toISOString()).toBe("2026-03-12T00:00:00.000Z");
  expect(list.range.toInstant.toISOString()).toBe("2026-03-13T00:00:00.000Z");
  const filtered = await loadActivityList(Promise.resolve({ ...params, type: "request", status: "failed" }));
  expect(filtered).toMatchObject({ state: "ready", total: 1, url: { page: 1 }, rows: [{ id: second.id }] });
  const detail = await loadActivityDetail(second.id, Promise.resolve({ page: "99", level: "error" }));
  expect(detail.state).toBe("ready");
  if (detail.state !== "ready") throw new Error("detail unavailable");
  expect(detail.url.page).toBe(1);
  expect(detail.events).toMatchObject({ total: 1, rows: [{ code: "item.failed", level: "error" }] });
  expect(detail.aiUsageHref).toBe("/sources/ai-usage?range=custom&from=2026-03-12&to=2026-03-12&task=translate");
  expect(await loadActivityDetail("invalid", Promise.resolve({}))).toEqual({ state: "not_found" });
  expect(await loadActivityDetail(activityRow().id, Promise.resolve({}))).toEqual({ state: "not_found" });
});

it("keeps AI usage aggregates, filters, unknown measurements, page clamping and export limits", async () => {
  await getDb().insert(schema.aiUsage).values([
    { provider: "anthropic", model: "example-model", task: "score", at, tokensIn: 100, tokensOut: 20, durationMs: 600, costEstimate: 0.2, equivalentCostUsd: 0.2, outcome: "ok" },
    { provider: "anthropic", model: "example-model", task: "score", at: new Date(at.getTime() + 1), tokensIn: null, tokensOut: null, durationMs: null },
    { provider: "codex-cli", model: null, task: "translate", at, tokensIn: 30, tokensOut: 10, durationMs: 200 },
    { provider: "anthropic", model: "example-model", task: "score", at: new Date("2026-03-11T23:59:59Z"), tokensIn: 999 },
  ]);
  const params = { range: "custom", from: "2026-03-12", to: "2026-03-12", provider: "anthropic", task: "score", page: "99", metric: "calls" };
  const data = await loadAiUsagePage(Promise.resolve(params), at);
  expect(data).toMatchObject({ today: "2026-03-12", timeZone: "UTC", totalCalls: 2, page: 2, pageSize: 1, csvMaxRows: 2 });
  expect(data.view.totals).toMatchObject({ calls: 2, tokenUnknownCalls: 1, tokensIn: 100, tokensOut: 20, actualUsd: 0.2, actualUnknownCalls: 1, avgDurationMs: 600 });
  expect(data.calls).toHaveLength(1);
  expect(data.calls[0]?.tokensIn).toBe(100);
  expect(data.exportHref).toBe("/sources/ai-usage/export?range=custom&from=2026-03-12&to=2026-03-12&provider=anthropic&task=score");
  const csv = await loadAiUsageCsvRows(Promise.resolve(params));
  expect(csv.rows).toHaveLength(2);
  const empty = await loadAiUsagePage(Promise.resolve({ ...params, task: "probe" }), at);
  expect(empty).toMatchObject({ calls: [], totalCalls: 0, page: 1, view: { empty: true } });
});
