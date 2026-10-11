import { describe, expect, it } from "vitest";

import { selectForPush, type SelectionConfig } from "@/lib/notify/select";

import { candidate } from "./helpers";

const config: SelectionConfig = { push_min_score: 70, push_min_score_high_value: 60, max_per_cycle: 10 };
const select = (candidates: ReturnType<typeof candidate>[], extra: { watched?: string[]; notified?: number[]; config?: Partial<SelectionConfig> } = {}) =>
  selectForPush(candidates, {
    config: { ...config, ...extra.config },
    watchedKeys: new Set(extra.watched ?? []),
    alreadyNotified: new Set(extra.notified ?? []),
  });
const ids = (items: { candidate: { jobId: number } }[]) => items.map((i) => i.candidate.jobId);

describe("selectForPush thresholds", () => {
  it("pushes a job at the threshold and not below it", () => {
    const result = select([candidate({ jobId: 1, rank: 70 }), candidate({ jobId: 2, rank: 69.9 })]);
    expect(ids(result.selected)).toEqual([1]);
    expect(result.skipped.belowThreshold).toBe(1);
  });

  it("uses the lower threshold when the job has a high-value signal (worked out by listPushCandidates)", () => {
    const result = select([
      candidate({ jobId: 1, rank: 62, signalTiers: ["T1"], highValue: true }),
      candidate({ jobId: 2, rank: 60, signalTiers: ["T2", "tag"], highValue: true }),
      candidate({ jobId: 3, rank: 59.9, signalTiers: ["T1"], highValue: true }),
      candidate({ jobId: 4, rank: 65, signalTiers: ["T3", "T4", "tag"], highValue: false }),
    ]);
    expect(ids(result.selected)).toEqual([1, 2]);
    expect(result.selected.map((s) => s.reason)).toEqual(["high_value", "high_value"]);
    expect(result.skipped.belowThreshold).toBe(2);
  });

  it("a job whose only amount is not a high-pay signal is not high value and keeps the normal threshold", () => {
    const result = select([candidate({ jobId: 1, rank: 67, signalTiers: ["T1", "T3"], highValue: false }), candidate({ jobId: 2, rank: 67, signalTiers: ["T1"], highValue: true })]);
    expect(ids(result.selected)).toEqual([2]);
    expect(result.skipped.belowThreshold).toBe(1);
  });

  it("without a high-value answer (a rebuilt message) a job keeps the normal threshold", () => {
    expect(select([candidate({ jobId: 1, rank: 65, signalTiers: ["T2"] })]).selected).toEqual([]);
  });

  it("labels a high-value job above the normal threshold as a threshold push", () => {
    const [item] = select([candidate({ rank: 80, signalTiers: ["T1"], highValue: true })]).selected;
    expect(item?.reason).toBe("threshold");
  });

  it("does not push jobs without a score or without a rank yet", () => {
    const result = select([candidate({ jobId: 1, unscored: true }), candidate({ jobId: 2, rank: null, match: null })]);
    expect(result.selected).toEqual([]);
    expect(result.skipped.unscored).toBe(2);
  });

  it("never pushes a job the hard filters removed, whatever its rank, watched or not", () => {
    const result = select(
      [candidate({ jobId: 1, rank: 95, filterResult: "filtered_out" }), candidate({ jobId: 2, rank: 95, filterResult: "filtered_out", companyNameNorm: "w" })],
      { watched: ["w"] },
    );
    expect(result.selected).toEqual([]);
    expect(result.skipped.filteredOut).toBe(2);
  });
});

describe("selectForPush watched companies", () => {
  it("pushes a watched company's job below the threshold and without a score", () => {
    const result = select(
      [candidate({ jobId: 1, rank: 10, companyNameNorm: "w" }), candidate({ jobId: 2, unscored: true, companyNameNorm: "w" }), candidate({ jobId: 3, rank: 10 })],
      { watched: ["w"] },
    );
    expect(ids(result.selected)).toEqual([1, 2]);
    expect(result.selected.every((s) => s.watched && s.reason === "watched")).toBe(true);
    expect(result.selected[1]?.rank).toBeNull();
  });

  it("also honours the companies.watched flag", () => {
    expect(ids(select([candidate({ jobId: 1, rank: 5, companyWatched: true })]).selected)).toEqual([1]);
  });
});

describe("selectForPush cap, order and dedupe", () => {
  it("orders by rank and cuts at max_per_cycle, reporting the overflow", () => {
    const list = [candidate({ jobId: 1, rank: 71 }), candidate({ jobId: 2, rank: 90 }), candidate({ jobId: 3, rank: 80 }), candidate({ jobId: 4, rank: 75 })];
    const result = select(list, { config: { max_per_cycle: 2 } });
    expect(ids(result.selected)).toEqual([2, 3]);
    expect(ids(result.overflow)).toEqual([4, 1]);
  });

  it("puts watched jobs without a rank after every ranked job and breaks ties by age, then id", () => {
    const early = new Date("2026-10-07T01:00:00Z");
    const list = [
      candidate({ jobId: 5, unscored: true, companyWatched: true }),
      candidate({ jobId: 4, rank: 80 }),
      candidate({ jobId: 3, rank: 80, firstSeenAt: early }),
      candidate({ jobId: 2, rank: 80 }),
    ];
    expect(ids(select(list).selected)).toEqual([3, 2, 4, 5]);
  });

  it("skips jobs that were already notified", () => {
    const result = select([candidate({ jobId: 1, rank: 90 }), candidate({ jobId: 2, rank: 90 })], { notified: [1] });
    expect(ids(result.selected)).toEqual([2]);
    expect(result.skipped.alreadyNotified).toBe(1);
  });

  it("returns nothing for no candidates", () => {
    expect(select([])).toEqual({ selected: [], overflow: [], skipped: { alreadyNotified: 0, filteredOut: 0, unscored: 0, belowThreshold: 0 } });
  });
});
