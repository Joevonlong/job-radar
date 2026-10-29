// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "@/lib/channels/logger";
import type { Db } from "@/lib/db/client";
import * as applications from "@/lib/db/repos/applications";
import * as favorites from "@/lib/db/repos/favorites";
import * as notifications from "@/lib/db/repos/notifications";
import { createUpdateHandler, type UpdateHandlerDeps } from "@/lib/notify/poller";
import { runReminders } from "@/lib/notify/reminders";
import { createTelegramClient, type TelegramUpdate } from "@/lib/notify/telegram-client";
import { notifyText } from "@/lib/notify/text";
import type { NotifyDeps } from "@/lib/notify/types";
import { fakeRecorder } from "../activity/helpers";
import { candidate, notifyConfig } from "./helpers";
import { FAKE_TOKEN } from "./fake-bot-api";

const db = {} as Db;
const now = new Date("2026-10-07T12:00:00Z");
const statusChange: applications.StatusChange = { applicationId: 1, previous: "new", status: "interested", changed: true };
const update = (data = "a:7:i", chat = 42): TelegramUpdate => ({
  update_id: 1, callback_query: { id: "callback", from: { id: 9 }, data, message: { message_id: 2, chat: { id: chat } } },
});

function setup() {
  const fake = fakeRecorder();
  const fetch = vi.fn(async (url: string) => ({ status: 200, text: async () => JSON.stringify({ ok: true, result: url.endsWith("sendMessage") ? { message_id: 3 } : true }) }));
  const client = createTelegramClient({ token: FAKE_TOKEN, baseUrl: "https://bot.example.test", requestTimeoutMs: 1000, maxRetries: 0, fetch });
  const config = notifyConfig();
  config.reminders.enabled = true;
  config.reminders.send_at = "09:00";
  config.quiet_hours.enabled = false;
  const deps: UpdateHandlerDeps = {
    db, client, chatId: "42", activity: fake.recorder, logger: silentLogger,
    getConfig: () => config, getWatchedKeys: () => new Set(), getText: () => notifyText("en"),
  };
  const reminders: NotifyDeps = { db, client, chatId: "42", config, activity: fake.recorder, logger: silentLogger, now: () => now, timeZone: "UTC", text: notifyText("en") };
  return { ...fake, deps, reminders, fetch, handle: (u = update()) => createUpdateHandler(deps).handle(u) };
}

beforeEach(() => {
  vi.spyOn(notifications, "getPushCandidate").mockResolvedValue(candidate({ jobId: 7 }));
  vi.spyOn(applications, "setApplicationStatus").mockResolvedValue(statusChange);
  vi.spyOn(favorites, "getFavorite").mockResolvedValue(null);
  vi.spyOn(notifications, "getLastNotificationAt").mockResolvedValue(null);
  vi.spyOn(notifications, "recordNotification").mockResolvedValue({ id: 1, kind: "reminder", cycleId: null, payloadJson: null, sentAt: now, telegramMessageId: null });
  vi.spyOn(applications, "listStaleApplications").mockResolvedValue({ total: 0, items: [] });
});
afterEach(() => vi.restoreAllMocks());

describe("Telegram callback activity", () => {
  it.each([true, false])("records a status changed=%s result once", async (changed) => {
    vi.mocked(applications.setApplicationStatus).mockResolvedValue({ ...statusChange, changed });
    const test = setup();
    await test.handle();
    expect(test.spans).toHaveLength(1);
    expect(test.spans[0]).toMatchObject({ name: "system.telegram_callback", links: { jobId: 7 }, items: [["item.ok", { jobId: 7, params: { action: "interested", result: changed ? "changed" : "unchanged" } }]], finishes: [["ok", undefined]] });
  });

  it.each([true, false])("records a favourite changed=%s result", async (changed) => {
    vi.spyOn(favorites, "addFavorite").mockResolvedValue({ changed });
    const test = setup();
    await test.handle(update("a:7:f"));
    expect(test.spans[0]?.items[0]).toEqual(["item.ok", { jobId: 7, params: { action: "favorite", result: changed ? "changed" : "unchanged" } }]);
    expect(test.spans[0]?.finishes).toEqual([["ok", undefined]]);
  });

  it.each(["rejected", "gone", "foreign_chat", "not_allowed", "invalid"] as const)("records %s as skipped", async (result) => {
    const test = setup();
    if (result === "rejected") vi.mocked(applications.setApplicationStatus).mockResolvedValue({ ...statusChange, rejected: true, changed: false });
    if (result === "gone") vi.mocked(notifications.getPushCandidate).mockResolvedValue(null);
    if (result === "not_allowed") test.deps.allowedUserIds = [10];
    await test.handle(update(result === "invalid" ? "private https://private.test" : "a:7:i", result === "foreign_chat" ? 43 : 42));
    expect(test.spans[0]?.items[0]).toEqual(["item.skipped", { ...(result === "invalid" ? {} : { jobId: 7 }), params: { ...(result === "invalid" ? {} : { action: "interested" }), result } }]);
    expect(test.spans[0]?.finishes).toEqual([["skipped", undefined]]);
    expect(JSON.stringify(test.spans[0]?.items)).not.toContain("private");
  });

  it.each(["not_found", "write_failed"] as const)("records export %s", async (error) => {
    const test = setup();
    test.deps.exportResume = async () => ({ ok: false, error });
    await test.handle(update("a:7:r"));
    expect(test.spans[0]?.items[0]?.[0]).toBe(error === "not_found" ? "item.skipped" : "item.failed");
    expect(test.spans[0]?.items[0]?.[1]?.params).toEqual({ action: "resume", result: error === "not_found" ? "gone" : "export_failed" });
    expect(test.spans[0]?.finishes).toEqual([[error === "not_found" ? "skipped" : "failed", undefined]]);
  });

  it("finishes the catch path once and keeps error text out of fields", async () => {
    vi.mocked(notifications.getPushCandidate).mockRejectedValue(new Error("private payload https://private.test"));
    const test = setup();
    await test.handle();
    expect(test.spans[0]?.items).toEqual([["item.failed", { jobId: 7, errorCode: "error", params: { action: "interested", result: "failed" } }]]);
    expect(test.spans[0]?.finishes).toEqual([["failed", { reasonCode: "error" }]]);
  });

  it("records failures before text loading and creates no root for text messages", async () => {
    const test = setup();
    test.deps.getText = () => { throw new Error("private"); };
    await test.handle();
    expect(test.spans[0]?.finishes).toEqual([["failed", { reasonCode: "error" }]]);
    await test.handle({ update_id: 2, message: { message_id: 3, chat: { id: 42 }, text: "private" } });
    expect(test.spans).toHaveLength(1);
  });
});

describe("reminder activity", () => {
  it.each(["disabled", "not_due", "quiet"] as const)("does not record %s checks", async (outcome) => {
    const test = setup();
    if (outcome === "disabled") test.reminders.config.reminders.enabled = false;
    if (outcome === "not_due") test.reminders.config.reminders.send_at = "13:00";
    if (outcome === "quiet") test.reminders.config.quiet_hours = { ...test.reminders.config.quiet_hours, enabled: true, start: "11:00", end: "13:00" };
    expect(await runReminders(test.reminders)).toBe(outcome);
    expect(test.spans).toEqual([]);
  });

  it.each(["sent", "empty", "failed"] as const)("records %s once with both totals", async (outcome) => {
    const test = setup();
    const total = outcome === "empty" ? 0 : 2;
    vi.mocked(applications.listStaleApplications).mockResolvedValue({ total, items: [] });
    if (outcome === "failed") test.fetch.mockRejectedValue(new Error("private"));
    expect(await runReminders(test.reminders)).toBe(outcome);
    expect(test.spans).toHaveLength(1);
    expect(test.spans[0]?.notes).toEqual([["info", "reminder_counts", { interested: total, applied: total }]]);
    expect(test.spans[0]?.finishes).toEqual([[outcome === "failed" ? "failed" : "ok", outcome === "failed" ? { reasonCode: "error" } : undefined]]);
  });

  it("propagates the same empty-notification write error and closes the root", async () => {
    const error = new Error("private");
    vi.mocked(notifications.recordNotification).mockRejectedValue(error);
    const test = setup();
    await expect(runReminders(test.reminders)).rejects.toBe(error);
    expect(test.spans[0]?.finishes).toEqual([["failed", { reasonCode: "error" }]]);
  });

  it("creates no root when the counts cannot be read", async () => {
    const test = setup();
    const error = new Error("private");
    vi.mocked(applications.listStaleApplications).mockRejectedValue(error);
    await expect(runReminders(test.reminders)).rejects.toBe(error);
    expect(test.spans).toEqual([]);
  });
});
