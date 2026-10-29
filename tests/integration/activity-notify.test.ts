import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it, vi } from "vitest";
import type { ActivityRecorder } from "@/lib/activity/types";
import { createConnection } from "@/lib/db/client";
import { getApplicationByJobId } from "@/lib/db/repos/applications";
import { applications, companies, jobs, notifications } from "@/lib/db/schema";
import { createUpdateHandler, runPoller } from "@/lib/notify/poller";
import { runReminders } from "@/lib/notify/reminders";
import { createTelegramClient } from "@/lib/notify/telegram-client";
import { notifyText } from "@/lib/notify/text";
import type { NotifyDeps } from "@/lib/notify/types";
import { quietLogger } from "../cycle/helpers";
import { FAKE_TOKEN } from "../notify/fake-bot-api";
import { notifyConfig } from "../notify/helpers";
import { activityRows, activityText, HOOK_NOW, hookRecorder, resetHookTables } from "./activity-hook-helpers";

let connection: ReturnType<typeof createConnection>;
let activity: ActivityRecorder;
beforeAll(() => { connection = createConnection(inject("testDatabaseUrl")); });
beforeEach(async () => { await resetHookTables(connection.db); activity = hookRecorder(connection.db); });
afterEach(async () => { await activity.close(); });
afterAll(async () => { await connection.sql.end(); });

function config() {
  const result = notifyConfig();
  result.telegram.enabled = true;
  result.reminders = { ...result.reminders, enabled: true, send_at: "09:00", interested_days: 2, applied_days: 3, max_items: 5 };
  result.quiet_hours.enabled = false;
  return result;
}

async function seedJob(title = "Private message text SECRET123") {
  const [company] = await connection.db.insert(companies).values({ name: "Example", nameNorm: "example" }).returning();
  const [job] = await connection.db.insert(jobs).values({ companyId: company!.id, title, titleNorm: title.toLowerCase() }).returning();
  return job!.id;
}

/** Exercise the actual Telegram wire decoder and client with a local function; no sockets or retries. */
function bot(batch: unknown[] = [], abort?: AbortController, sendFails = false) {
  const fetch = vi.fn(async (url: string) => {
    if (url.endsWith("getUpdates")) {
      abort?.abort();
      return { status: 200, text: async () => JSON.stringify({ ok: true, result: batch }) };
    }
    if (url.endsWith("sendMessage") && sendFails) throw new Error("private send failure SECRET123");
    return { status: 200, text: async () => JSON.stringify({ ok: true, result: url.endsWith("sendMessage") ? { message_id: 3 } : true }) };
  });
  const client = createTelegramClient({ token: FAKE_TOKEN, baseUrl: "https://bot.example.test", requestTimeoutMs: 1000, maxRetries: 0, fetch, sleep: async () => {} });
  return { client, fetch };
}

describe("notification activity persistence", () => {
  it.each(["valid", "unknown", "missing", "foreign"] as const)("records one safe telegram_callback root for a %s callback delivered by the poller", async (scenario) => {
    const jobId = await seedJob();
    const abort = new AbortController();
    const data = scenario === "unknown" ? "https://x.example/?token=SECRET123" : `a:${jobId}:i`;
    const messageText = "Private message text SECRET123";
    const update = { update_id: 1, callback_query: {
      id: "private callback identifier", from: { id: 9 }, ...(scenario === "missing" ? {} : { data }),
      message: { message_id: 2, chat: { id: scenario === "foreign" ? 43 : 42 }, text: messageText },
    } };
    const fake = bot([update], abort);
    const notify = config();
    const handler = createUpdateHandler({ db: connection.db, activity, client: fake.client, chatId: "42", logger: quietLogger,
      getConfig: () => notify, getWatchedKeys: () => new Set(), getText: () => notifyText("en") });
    await runPoller({ client: fake.client, handler, signal: abort.signal, logger: quietLogger, getConfig: () => notify,
      sleep: async () => { throw new Error("unexpected poller backoff"); } });
    await activity.flush();
    const { spans, events } = await activityRows(connection.db);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "system.telegram_callback", scope: "system", parentId: null,
      status: scenario === "valid" ? "ok" : "skipped" });
    expect(spans[0]!.finishedAt).toBeInstanceOf(Date);
    const decoded = scenario === "valid" || scenario === "foreign";
    const result = scenario === "valid" ? "changed" : scenario === "foreign" ? "foreign_chat" : "invalid";
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ spanId: spans[0]!.id, rootId: spans[0]!.id,
      code: scenario === "valid" ? "item.ok" : "item.skipped", params: { ...(decoded ? { action: "interested" } : {}), result } });
    // Exact equality excludes callback data, text, ids or future unapproved payload fields from params.
    expect(events[0]!.params).toEqual({ ...(decoded ? { action: "interested" } : {}), result });
    expect(await getApplicationByJobId(connection.db, jobId)).toEqual(scenario === "valid" ? expect.objectContaining({ status: "interested" }) : null);
    const text = await activityText(connection.db);
    for (const sample of [data, messageText, "SECRET123", update.callback_query.id]) expect(text).not.toContain(sample);
    expect(fake.fetch.mock.calls.filter(([url]) => url.endsWith("getUpdates"))).toHaveLength(1);
    if (scenario === "foreign") expect(fake.fetch).toHaveBeenCalledTimes(1);
  });

  it("creates no activity roots for text messages from either the configured or a foreign chat", async () => {
    const abort = new AbortController();
    const fake = bot([42, 43].map((chat, index) => ({ update_id: index + 1,
      message: { message_id: index + 1, chat: { id: chat }, text: "private text SECRET123" } })), abort);
    const notify = config();
    const handler = createUpdateHandler({ db: connection.db, activity, client: fake.client, chatId: "42", logger: quietLogger,
      getConfig: () => notify, getWatchedKeys: () => new Set(), getText: () => notifyText("en") });
    await runPoller({ client: fake.client, handler, signal: abort.signal, logger: quietLogger, getConfig: () => notify, sleep: async () => {} });
    await activity.flush();
    expect(await activityRows(connection.db)).toEqual({ spans: [], events: [] });
    expect(fake.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["sent", "empty", "failed"] as const)("records an %s reminder with real application counts and a terminal root", async (outcome) => {
    if (outcome !== "empty") {
      const jobId = await seedJob();
      await connection.db.insert(applications).values({ jobId, status: "interested", statusChangedAt: new Date("2026-09-01T12:00:00Z") });
    }
    const fake = bot([], undefined, outcome === "failed");
    const deps: NotifyDeps = { db: connection.db, activity, client: fake.client, chatId: "42", config: config(),
      logger: quietLogger, now: () => HOOK_NOW, timeZone: "UTC", text: notifyText("en"), sleep: async () => {} };
    expect(await runReminders(deps)).toBe(outcome);
    await activity.flush();
    const { spans, events } = await activityRows(connection.db);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ name: "system.reminder", scope: "system", parentId: null,
      status: outcome === "failed" ? "failed" : "ok", reasonCode: outcome === "failed" ? "error" : null });
    expect(spans[0]!.finishedAt).toBeInstanceOf(Date);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ spanId: spans[0]!.id, code: "reminder_counts", params: { interested: outcome === "empty" ? 0 : 1, applied: 0 } });
    expect(await connection.db.select().from(notifications)).toHaveLength(outcome === "failed" ? 0 : 1);
    expect(fake.fetch).toHaveBeenCalledTimes(outcome === "empty" ? 0 : 1);
    const text = await activityText(connection.db);
    expect(text).not.toContain("SECRET123");
    expect(text).not.toContain("private send failure");
  });

  it.each(["disabled", "not_due", "quiet"] as const)("creates no reminder root when %s", async (outcome) => {
    const notify = config();
    if (outcome === "disabled") notify.reminders.enabled = false;
    if (outcome === "not_due") notify.reminders.send_at = "13:00";
    if (outcome === "quiet") notify.quiet_hours = { ...notify.quiet_hours, enabled: true, start: "11:00", end: "13:00" };
    const fake = bot();
    expect(await runReminders({ db: connection.db, activity, client: fake.client, chatId: "42", config: notify,
      logger: quietLogger, now: () => HOOK_NOW, timeZone: "UTC", text: notifyText("en") })).toBe(outcome);
    await activity.flush();
    expect(await activityRows(connection.db)).toEqual({ spans: [], events: [] });
    expect(fake.fetch).not.toHaveBeenCalled();
  });
});
