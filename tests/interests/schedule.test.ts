// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createLogger } from "@/lib/channels/logger";
import { createSuggestScheduler, isSuggestOverdue } from "@/lib/interests/suggest-schedule";
import { formatSuggestionsMessage } from "@/lib/interests/suggest-notify";
import { suggestionPayloadSchema, type SuggestionPayload } from "@/lib/interests/suggestion";

import { shippedSuggest } from "./helpers";
import { notifyText } from "@/lib/notify/text";

const quiet = createLogger({ sink: () => {} });
const CRON = "0 8 * * 1"; // Monday 08:00
const TZ = "Europe/Berlin";

describe("isSuggestOverdue", () => {
  const now = new Date("2026-10-07T10:00:00Z"); // Wednesday; the slot was Monday 2026-10-05 08:00 Berlin = 06:00 UTC

  it("is overdue when nothing was ever requested", () => {
    expect(isSuggestOverdue({ now, cron: CRON, timeZone: TZ, lastRequestedAt: null })).toBe(true);
  });

  it("is overdue when the last request is older than the latest slot", () => {
    expect(isSuggestOverdue({ now, cron: CRON, timeZone: TZ, lastRequestedAt: new Date("2026-09-28T06:00:05Z") })).toBe(true);
  });

  it("is not overdue once a request is at or after the latest slot", () => {
    expect(isSuggestOverdue({ now, cron: CRON, timeZone: TZ, lastRequestedAt: new Date("2026-10-05T06:00:03Z") })).toBe(false);
    expect(isSuggestOverdue({ now, cron: CRON, timeZone: TZ, lastRequestedAt: new Date("2026-10-06T00:00:00Z") })).toBe(false);
  });
});

describe("createSuggestScheduler", () => {
  it("schedules the cron in the time zone and reschedules on a config change", () => {
    const scheduler = createSuggestScheduler({ config: shippedSuggest(), timeZone: TZ, logger: quiet, onTrigger: vi.fn() });
    try {
      const next = scheduler.nextRun();
      expect(next?.getUTCDay()).toBe(1);
      // 08:00 Berlin is 06:00 UTC in summer time and 07:00 UTC in winter time
      expect([6, 7]).toContain(next?.getUTCHours());
      scheduler.reschedule(shippedSuggest((raw) => (raw.cron = "0 9 * * 3")), TZ);
      expect(scheduler.nextRun()?.getUTCDay()).toBe(3);
    } finally {
      scheduler.stop();
    }
  });

  it("has no job while suggest.enabled is off", () => {
    const scheduler = createSuggestScheduler({ config: shippedSuggest((raw) => (raw.enabled = false)), timeZone: TZ, logger: quiet, onTrigger: vi.fn() });
    expect(scheduler.nextRun()).toBeNull();
    scheduler.reschedule(shippedSuggest(), TZ);
    expect(scheduler.nextRun()).not.toBeNull();
    scheduler.stop();
    expect(scheduler.nextRun()).toBeNull();
  });
});

describe("formatSuggestionsMessage", () => {
  const evidence = [{ jobId: 1, title: "t", company: "c" }];
  const common = { reasonZh: "理由", reasonEn: "reason", confidence: 0.7, evidence };
  const payloads: SuggestionPayload[] = [
    suggestionPayloadSchema.parse({ kind: "signal_word", tier: "T2", term: "phantom <units>", ...common }),
    suggestionPayloadSchema.parse({ kind: "watched_company", company: "Acme & Co", ...common }),
    suggestionPayloadSchema.parse({ kind: "filter", action: "add_location", value: "Hamburg", ...common }),
  ];

  it("counts the suggestions, lists them with HTML escaped, and links to the page when a base URL is set", () => {
    const text = formatSuggestionsMessage({ payloads, publicBaseUrl: "http://100.1.2.3:3000/" }, notifyText("zh"));
    expect(text).toContain("本周有 3 条新的兴趣建议");
    expect(text).toContain("词（T2）：phantom &lt;units&gt;");
    expect(text).toContain("关注公司：Acme &amp; Co");
    expect(text).toContain("增加城市：Hamburg");
    expect(text).toContain('<a href="http://100.1.2.3:3000/interests">');
  });

  it("without a base URL it only names the page, and a long list is cut", () => {
    const many = Array.from({ length: 9 }, (_, i) => suggestionPayloadSchema.parse({ kind: "signal_word", tier: "T3", term: `word ${i}`, ...common }));
    const text = formatSuggestionsMessage({ payloads: many, publicBaseUrl: null }, notifyText("zh"));
    expect(text).toContain("还有 3 条");
    expect(text).not.toContain("<a ");
    expect(text).toContain("/interests");
  });
});
