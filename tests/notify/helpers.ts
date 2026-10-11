import { configRegistry, type NotifyConfig } from "@/lib/config";
import type { PushCandidate } from "@/lib/db/repos/notifications";
import type { JobSalary } from "@/lib/domain/types";

import { shippedYaml } from "../config/helpers";
import { asSalary } from "../helpers/salary";

/** The shipped notify.yaml, optionally edited (re-validated). */
export function notifyConfig(edit: (raw: Record<string, unknown> & { telegram: Record<string, unknown>; quiet_hours: Record<string, unknown> }) => void = () => {}): NotifyConfig {
  const raw = structuredClone(shippedYaml("notify.yaml")) as Record<string, unknown> & { telegram: Record<string, unknown>; quiet_hours: Record<string, unknown> };
  edit(raw);
  return configRegistry.notify.schema.parse(raw);
}

let nextId = 1;

type CandidateOverrides = Partial<Omit<PushCandidate, "score">> & {
  /** Rank value of the score row (default 75); null = a score row without a rank yet. */
  rank?: number | null;
  /** AI match score (default: the rank). */
  match?: number | null;
  signalBonus?: number;
  filterResult?: "passed" | "filtered_out";
  /** No score row at all. */
  unscored?: boolean;
};

export function candidate(overrides: CandidateOverrides = {}): PushCandidate {
  const { rank = 75, match, signalBonus = 0, filterResult = "passed", unscored = false, ...rest } = overrides;
  const jobId = rest.jobId ?? nextId++;
  return {
    jobId,
    title: `Job ${jobId}`,
    companyName: "Acme GmbH",
    companyNameNorm: "acme",
    companyWatched: false,
    locations: ["Berlin"],
    workplace: "hybrid",
    germanLevelRequired: "none",
    firstSeenAt: new Date("2026-10-07T05:00:00Z"),
    score: unscored ? null : { filterResult, score: match === undefined ? rank : match, signalBonus, rankValue: rank, summaries: { zh: "一句话摘要" }, outputLang: "zh" },
    salary: null,
    signalTiers: [],
    sourceUrl: `https://jobs.example.test/${jobId}`,
    ...rest,
  };
}

/** A normalized salary of `min`–`max` EUR per year. */
export function salary(min: number | null, max: number | null, over: Partial<JobSalary> = {}): JobSalary {
  const range = { min, max };
  return asSalary({
    raw: "salary",
    currency: "EUR",
    period: "year",
    min,
    max,
    perYear: range,
    eurPerYear: range,
    periodAssumed: false,
    origin: "text",
    qualityStatus: "valid",
    reasonCodes: [],
    ...over,
  });
}
