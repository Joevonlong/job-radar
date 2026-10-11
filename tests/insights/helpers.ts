import type { InsightsData } from "@/lib/db/repos/insights";

/** An /insights data set with nothing in it. */
export const emptyData = (): InsightsData => ({
  daily: [],
  previousTotal: 0,
  previousPassed: 0,
  sources: [],
  cities: { total: 0, remote: 0, other: 0, cities: [{ city: "Berlin", count: 0 }] },
  salary: { total: 0, disclosed: 0, comparable: 0, medianEurPerYear: null, minSample: 5, buckets: [] },
  signals: { total: 0, tiers: [{ tier: "T1", jobs: 0, avgRank: null }, { tier: "T2", jobs: 0, avgRank: null }, { tier: "T3", jobs: 0, avgRank: null }, { tier: "T4", jobs: 0, avgRank: null }], withoutSignal: 0, highPay: 0, scored: 0, avgRank: null },
  scores: { atPushLine: 0, scored: 0, pending: 0, avgRank: null, buckets: [] },
  funnel: { newJobs: 0, reached: { interested: 0, preparing: 0, applied: 0, interviewing: 0, offer: 0 }, exits: { rejected: 0, withdrawn: 0, archived: 0 } },
  filters: { total: 0, reasons: [] },
  scoreCapIndex: 20,
  salaryCapIndex: 15,
});
