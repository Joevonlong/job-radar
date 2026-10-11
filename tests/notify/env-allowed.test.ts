// @vitest-environment node
import { describe, expect, it } from "vitest";

import { loadTelegramEnv, parseAllowedUserIds } from "@/lib/env";

const base = { TELEGRAM_BOT_TOKEN: "123456:ABC-test_token", TELEGRAM_CHAT_ID: "-100123" };

describe("TELEGRAM_ALLOWED_USER_IDS", () => {
  it("is optional and parsed into numbers", () => {
    expect(parseAllowedUserIds(loadTelegramEnv(base)?.TELEGRAM_ALLOWED_USER_IDS)).toBeNull();
    expect(parseAllowedUserIds(loadTelegramEnv({ ...base, TELEGRAM_ALLOWED_USER_IDS: "" })?.TELEGRAM_ALLOWED_USER_IDS)).toBeNull();
    expect(parseAllowedUserIds(loadTelegramEnv({ ...base, TELEGRAM_ALLOWED_USER_IDS: " 11, 22 ,33," })?.TELEGRAM_ALLOWED_USER_IDS)).toEqual([11, 22, 33]);
  });
  it("rejects anything but numbers, naming the variable and not the value", () => {
    expect(() => loadTelegramEnv({ ...base, TELEGRAM_ALLOWED_USER_IDS: "me,you" })).toThrow(/TELEGRAM_ALLOWED_USER_IDS/);
    try {
      loadTelegramEnv({ ...base, TELEGRAM_ALLOWED_USER_IDS: "secretvalue" });
    } catch (error) {
      expect(String(error)).not.toContain("secretvalue");
    }
  });
});
