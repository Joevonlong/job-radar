import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { loadTelegramEnv } from "@/lib/env";

import { shippedYaml } from "../config/helpers";
import { notifyConfig } from "./helpers";

const issues = (raw: unknown): string[] => {
  const result = configRegistry.notify.schema.safeParse(raw);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};
const shipped = () => structuredClone(shippedYaml("notify.yaml")) as Record<string, unknown> & { telegram: object; alerts: object; reminders: object };

describe("notify.yaml", () => {
  it("ships the documented defaults", () => {
    const config = notifyConfig();
    expect(config.telegram).toMatchObject({ api_base_url: "https://api.telegram.org", poll_timeout_seconds: 30 });
    expect(config).toMatchObject({ push_min_score: 70, push_min_score_high_value: 60, max_per_cycle: 10, candidate_window_hours: 48 });
    expect(config.alerts).toEqual({ dedupe_hours: 24, budget_thresholds: [0.8, 1] });
    expect(config.reminders).toMatchObject({ enabled: true, send_at: "09:00", interested_days: 7, applied_days: 14 });
  });

  it("accepts a Tailscale-style public_base_url and rejects other schemes", () => {
    const ok = shipped();
    ok.public_base_url = "http://100.64.0.1:3000";
    expect(issues(ok)).toEqual([]);
    const bad = shipped();
    bad.public_base_url = "ftp://x.test";
    expect(issues(bad)).toContain("public_base_url");
  });

  it("rejects out-of-range values", () => {
    const bad = shipped();
    Object.assign(bad.telegram, { poll_timeout_seconds: 120, api_base_url: "not a url" });
    Object.assign(bad.alerts, { dedupe_hours: 0, budget_thresholds: [0.8, 0.8] });
    Object.assign(bad.reminders, { send_at: "9am", max_items: 0 });
    bad.candidate_window_hours = -1;
    expect(issues(bad).sort()).toEqual(
      ["alerts.budget_thresholds", "alerts.dedupe_hours", "candidate_window_hours", "reminders.max_items", "reminders.send_at", "telegram.api_base_url", "telegram.poll_timeout_seconds"].sort(),
    );
  });

  it("rejects unknown keys (a secret must not hide in this file)", () => {
    const bad = shipped();
    Object.assign(bad.telegram, { bot_token: "x" });
    expect(issues(bad)).toEqual(["telegram"]);
  });
});

describe("loadTelegramEnv", () => {
  const token = "123456:ABC-def_GHI";

  it("is null when neither variable is set (empty counts as unset)", () => {
    expect(loadTelegramEnv({})).toBeNull();
    expect(loadTelegramEnv({ TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "" })).toBeNull();
  });

  it("returns the credentials, accepting a negative group chat id", () => {
    expect(loadTelegramEnv({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-1001234" })).toEqual({ TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHAT_ID: "-1001234" });
  });

  it("throws when only one is set and never echoes a value", () => {
    expect(() => loadTelegramEnv({ TELEGRAM_BOT_TOKEN: token })).toThrow(/TELEGRAM_CHAT_ID/);
    try {
      loadTelegramEnv({ TELEGRAM_BOT_TOKEN: "not-a-token-hunter2", TELEGRAM_CHAT_ID: "abc" });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).toMatch(/TELEGRAM_BOT_TOKEN/);
      expect(String(error)).not.toContain("hunter2");
      expect(String(error)).not.toContain("abc");
    }
  });
});
