import { describe, expect, it } from "vitest";

import { selectCandidates } from "@/lib/interests/suggest-select";

import { shippedSuggest, sourceJob } from "./helpers";

const config = shippedSuggest();

describe("selectCandidates", () => {
  it("puts the furthest status first, then the newest change", () => {
    const rows = [
      sourceJob({ jobId: 1, applicationStatus: "interested", statusChangedAt: new Date("2026-10-05T00:00:00Z") }),
      sourceJob({ jobId: 2, applicationStatus: "applied", statusChangedAt: new Date("2026-10-01T00:00:00Z") }),
      sourceJob({ jobId: 3, applicationStatus: "interested", statusChangedAt: new Date("2026-10-06T00:00:00Z") }),
      sourceJob({ jobId: 4, applicationStatus: "offer", statusChangedAt: new Date("2026-09-20T00:00:00Z") }),
      sourceJob({ jobId: 5, applicationStatus: "preparing", statusChangedAt: new Date("2026-10-02T00:00:00Z") }),
    ];
    expect(selectCandidates(rows, config).positive.map((j) => j.jobId)).toEqual([4, 2, 5, 3, 1]);
  });

  it("splits liked from ignored and drops every other status", () => {
    const rows = [
      sourceJob({ jobId: 1, applicationStatus: "interested" }),
      sourceJob({ jobId: 2, applicationStatus: "archived", statusChangedAt: new Date("2026-10-03T00:00:00Z") }),
      sourceJob({ jobId: 3, applicationStatus: "archived", statusChangedAt: new Date("2026-10-04T00:00:00Z") }),
      sourceJob({ jobId: 4, applicationStatus: "rejected" }),
      sourceJob({ jobId: 5, applicationStatus: "new" }),
    ];
    const result = selectCandidates(rows, config);
    expect(result.positive.map((j) => j.jobId)).toEqual([1]);
    expect(result.ignored.map((j) => j.jobId)).toEqual([3, 2]);
  });

  it("keeps at most max_positive_jobs and max_ignored_jobs", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => sourceJob({ jobId: 10 + i, applicationStatus: "interested", statusChangedAt: new Date(2026, 9, 1 + i) })),
      ...Array.from({ length: 5 }, (_, i) => sourceJob({ jobId: 20 + i, applicationStatus: "archived", statusChangedAt: new Date(2026, 9, 1 + i) })),
    ];
    const limited = selectCandidates(rows, { ...config, max_positive_jobs: 2, max_ignored_jobs: 1 });
    expect(limited.positive.map((j) => j.jobId)).toEqual([14, 13]);
    expect(limited.ignored.map((j) => j.jobId)).toEqual([24]);
    expect(selectCandidates(rows, { ...config, max_ignored_jobs: 0 }).ignored).toEqual([]);
  });

  it("follows the statuses the config names", () => {
    const rows = [sourceJob({ jobId: 1, applicationStatus: "interested" }), sourceJob({ jobId: 2, applicationStatus: "applied" })];
    expect(selectCandidates(rows, { ...config, positive_statuses: ["applied"] }).positive.map((j) => j.jobId)).toEqual([2]);
  });

  it("lists a job once", () => {
    const row = sourceJob({ jobId: 7 });
    expect(selectCandidates([row, row], config).positive).toHaveLength(1);
  });
});
