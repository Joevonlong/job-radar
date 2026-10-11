// @vitest-environment node
/** `market:regress` compares two snapshots by counts and code values. */
import { describe, expect, it } from "vitest";

import { compareRegressSnapshots, REGRESS_FIELDS, renderRegressComparison, type JobFacts, type RegressSnapshot } from "@/lib/market/regress";

const facts = (over: Partial<JobFacts> = {}): JobFacts => ({ ...(Object.fromEntries(REGRESS_FIELDS.map((f) => [f, ""])) as JobFacts), countries: "DE", localLevel: "B2", salaryBase: "80k EUR", ...over });
const snap = (jobs: Record<string, JobFacts>): RegressSnapshot => ({ version: 1, takenAt: "2026-10-09T00:00:00.000Z", jobs });

describe("compareRegressSnapshots", () => {
  it("counts changed jobs per field and lists code transitions, not amounts", () => {
    const base = snap({ 1: facts(), 2: facts({ countries: "" }), 3: facts(), 4: facts() });
    const head = snap({ 1: facts(), 2: facts({ countries: "US" }), 3: facts({ localLevel: "unknown", salaryBase: "94k USD" }), 5: facts() });
    const c = compareRegressSnapshots(base, head);
    expect(c).toMatchObject({ base: 4, head: 4, both: 3, onlyBase: 1, onlyHead: 1, changedJobs: 2 });
    expect(c.fields.countries).toEqual({ changed: 1, transitions: [{ from: "", to: "US", count: 1 }] });
    expect(c.fields.localLevel.transitions).toEqual([{ from: "B2", to: "unknown", count: 1 }]);
    expect(c.fields.salaryBase).toEqual({ changed: 1, transitions: [] });
    const text = renderRegressComparison(c).join("\n");
    expect(text).toContain("∅ -> US: 1");
    expect(text).not.toContain("94k");
  });

  it("finds nothing between identical snapshots", () => {
    const s = snap({ 1: facts() });
    expect(compareRegressSnapshots(s, s).changedJobs).toBe(0);
  });
});
