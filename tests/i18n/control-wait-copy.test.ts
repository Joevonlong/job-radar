// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONTROL_REQUEST_KINDS } from "@/lib/db/repos/control-requests";

import { messageLeaves } from "../../scripts/i18n-catalog";

const MESSAGES_DIR = path.resolve(import.meta.dirname, "../../messages");
const load = (locale: string): Map<string, unknown> => messageLeaves(JSON.parse(fs.readFileSync(path.join(MESSAGES_DIR, `${locale}.json`), "utf8")));
const LOCALES = ["en", "zh"] as const;

/** What a waiting request says: no promise of a few seconds, no fixed wait limit (whether the process is alive comes from its heartbeat). */
const WAIT_KEYS = ["translation.queued", "interestSuggestions.run.queued", "trigger.queued", "trigger.pending.runner", "trigger.pending.aiWorker"];
const WAIT_PREFIXES = ["controlQueue."];
/** The old "gave up after a fixed time" messages: gone. */
const REMOVED_KEYS = [
  "translation.error.waitTimeout",
  "jdBreakdown.error.waitTimeout",
  "salary.error.waitTimeout",
  "trigger.stillWaiting.runner",
  "trigger.stillWaiting.aiWorker",
  "dashboard.detail.scoreNow.runnerDown",
];
const FORBIDDEN = [/few seconds/i, /within seconds/i, /几秒/, /10 minutes/i, /10 分钟/, /12 minutes/i, /12 分钟/];

describe.each(LOCALES)("waiting copy (%s)", (locale) => {
  const messages = load(locale);

  it("promises no time and names no fixed limit", () => {
    const keys = [...WAIT_KEYS, ...[...messages.keys()].filter((key) => WAIT_PREFIXES.some((prefix) => key.startsWith(prefix)))];
    expect(keys.length).toBeGreaterThan(WAIT_KEYS.length);
    for (const key of keys) {
      const value = messages.get(key);
      expect(typeof value, key).toBe("string");
      for (const pattern of FORBIDDEN) expect(value, `${key} ~ ${pattern}`).not.toMatch(pattern);
    }
  });

  it("has no wait-limit messages any more", () => {
    for (const key of REMOVED_KEYS) expect(messages.has(key), key).toBe(false);
  });

  it("keeps the translation queue copy independent of the claiming process", () => {
    expect(messages.get("translation.queued")).not.toMatch(/Mac|ai[ -]?worker|runner/i);
  });

  it("names every control request kind", () => {
    for (const kind of CONTROL_REQUEST_KINDS) {
      const value = messages.get(`settings.control.requests.kind.${kind}`);
      expect(typeof value, kind).toBe("string");
      expect(String(value).trim(), kind).not.toBe("");
    }
  });
});
