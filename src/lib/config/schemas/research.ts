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

/** config/research.yaml: the company background on the job page (AI with web search, off by default). */
export const researchSchema = z.strictObject({
  /** Master switch. false (the default): no button, and the ai-worker refuses a request queued before it was turned off. */
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
});
export type ResearchConfig = z.infer<typeof researchSchema>;
