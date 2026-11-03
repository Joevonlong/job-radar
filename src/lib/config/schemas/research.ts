import { z } from "zod";

import { isPublicSuffixLike, isPublicWebsiteDomain } from "@/lib/ai/web-tasks";

import { nonNegativeNumber, positiveInt } from "./common";

const noDuplicates = (items: readonly string[]): boolean => new Set(items).size === items.length;

/** A host this machine may fetch pages from: refused here when it is an IP address, a local name or a public suffix. */
const fetchDomain = z.string().refine(isPublicWebsiteDomain, "must be a lower-case public host name such as linkedin.com (no IP address, no local name, no public suffix)");

/** A job board or applicant tracking host: lower case, at least one dot, one site. */
const hostName = z
  .string()
  .regex(/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, "must be a lower-case host name such as greenhouse.io")
  .refine((value) => !isPublicSuffixLike(value), "must name one site, not a public suffix such as co.uk or github.io");

export const RESEARCH_AUTO_TRIGGERS = ["manual", "favorite", "favorite_or_applying"] as const;
export const RESEARCH_ITEMS = ["company", "breakdown", "salary"] as const;
export type ResearchItem = (typeof RESEARCH_ITEMS)[number];

const autoSchema = z.strictObject({
  /** When research starts by itself: never, when a job is saved, or also when its status becomes interested, preparing or applied. */
  trigger: z.enum(RESEARCH_AUTO_TRIGGERS),
  /** Which parts run automatically. */
  items: z.array(z.enum(RESEARCH_ITEMS)).refine(noDuplicates, "must not contain duplicates"),
  /** Most automatic runs per 24 hours for saved or applied jobs, counted per job. */
  max_per_day: positiveInt,
  high_score: z.strictObject({
    enabled: z.boolean(),
    /** Rank value (0-100) a new job must reach. */
    min_rank: z.number().int().min(0).max(100),
    per_cycle_limit: positiveInt,
    /** Only jobs first seen within this many days. */
    max_age_days: positiveInt,
    /** Most automatic runs per 24 hours for high-score new jobs, counted apart from `auto.max_per_day`. */
    max_per_day: positiveInt,
  }),
});

/**
 * A file written before these keys existed never agreed to research starting by itself: it stays manual until the user chooses
 * otherwise. The shipped file sets the values new installations start from.
 */
const AUTO_WHEN_ABSENT: z.infer<typeof autoSchema> = {
  trigger: "manual",
  items: [...RESEARCH_ITEMS],
  max_per_day: 10,
  high_score: { enabled: false, min_rank: 80, per_cycle_limit: 3, max_age_days: 3, max_per_day: 5 },
};

/** config/research.yaml: the company background on the job page (AI with web search, off by default). */
export const researchSchema = z.strictObject({
  /** Master switch. false (the default): no button, nothing starts by itself, and the ai-worker refuses a request queued before it was turned off. */
  enabled: z.boolean(),
  company: z.strictObject({
    /** A company's result is shown from the cache for this many days. */
    ttl_days: positiveInt,
    /** Most lookups queued per 24 hours, failed ones included (a cached answer does not count). */
    max_per_day: positiveInt,
    /** Most web searches one lookup may make (enforced for the Anthropic API; the CLIs are asked to keep to it). */
    max_searches: positiveInt.max(20),
    /** One lookup (every provider and retry together) may take this many seconds. */
    timeout_seconds: positiveInt,
    /** Longest text kept per field. */
    max_field_chars: positiveInt.min(40).max(2000),
    /** Hosts the Claude CLI may fetch pages from and the Anthropic API may take search results from. */
    allowed_domains: z.array(fetchDomain).max(30).refine(noDuplicates, "must not contain duplicates"),
    /** Hosts never taken as a company's own website. */
    non_company_hosts: z.array(hostName).max(100).refine(noDuplicates, "must not contain duplicates"),
    /** A stated company size outside this range is dropped as implausible. */
    employees: z.strictObject({ min: nonNegativeNumber, max: nonNegativeNumber }).refine((range) => range.min < range.max, "min must be below max"),
    /** A stated review rating outside this range is dropped as implausible. */
    rating: z.strictObject({ min: nonNegativeNumber, max: nonNegativeNumber }).refine((range) => range.min < range.max, "min must be below max"),
    /** USD per web search of the Anthropic API (counted in ai_usage and the monthly API budget). */
    web_search_usd: nonNegativeNumber.default(0.01),
  }),
  auto: autoSchema.default(AUTO_WHEN_ABSENT),
});
export type ResearchConfig = z.infer<typeof researchSchema>;
