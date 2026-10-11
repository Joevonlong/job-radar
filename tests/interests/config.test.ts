import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";
import { shippedSuggest } from "./helpers";

const parseSchedule = (edit: (suggest: Record<string, unknown>) => void) => {
  const raw = structuredClone(shippedYaml("schedule.yaml"));
  edit(raw.suggest as Record<string, unknown>);
  return configRegistry.schedule.schema.safeParse(raw);
};

describe("schedule.yaml: suggest block", () => {
  it("ships Monday 08:00, four weeks, liked statuses and the evidence minimums", () => {
    const suggest = shippedSuggest();
    expect(suggest).toMatchObject({ enabled: true, cron: "0 8 * * 1", lookback_weeks: 4, ignored_statuses: ["archived"], notify: true });
    expect(suggest.positive_statuses).toEqual(["interested", "preparing", "applied", "interviewing", "offer"]);
    expect(suggest.min_evidence).toEqual({ signal_word: 2, watched_company: 1, filter: 2 });
  });

  it("a file without the block gets the defaults, which are the shipped values", () => {
    const raw = structuredClone(shippedYaml("schedule.yaml"));
    delete raw.suggest;
    const parsed = configRegistry.schedule.schema.parse(raw);
    expect(parsed.suggest).toEqual(shippedSuggest());
  });

  it("rejects a bad cron, zero weeks, a confidence outside 0..1, overlapping statuses and unknown keys", () => {
    for (const edit of [
      (s: Record<string, unknown>) => (s.cron = "0 25 * * 1"),
      (s: Record<string, unknown>) => (s.lookback_weeks = 0),
      (s: Record<string, unknown>) => (s.min_confidence = 1.2),
      (s: Record<string, unknown>) => (s.ignored_statuses = ["interested"]),
      (s: Record<string, unknown>) => (s.positive_statuses = []),
      (s: Record<string, unknown>) => (s.positive_statuses = ["interested", "interested"]),
      (s: Record<string, unknown>) => (s.positive_statuses = ["liked"]),
      (s: Record<string, unknown>) => (s.oops = true),
      (s: Record<string, unknown>) => delete s.min_evidence,
    ]) {
      expect(parseSchedule(edit).success).toBe(false);
    }
  });

  it("the YAML file carries every key (nothing silently defaulted)", () => {
    const text = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/defaults/schedule.yaml"), "utf8");
    const raw = parse(text) as { suggest: Record<string, unknown> };
    expect(Object.keys(raw.suggest).sort()).toEqual(
      ["cron", "enabled", "ignored_statuses", "jd_max_chars", "lookback_weeks", "max_ignored_jobs", "max_positive_jobs", "max_suggestions", "max_term_chars", "min_confidence", "min_evidence", "min_positive_jobs", "notify", "positive_statuses"].sort(),
    );
  });
});
