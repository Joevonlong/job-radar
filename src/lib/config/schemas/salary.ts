import { z } from "zod";

import { isPublicSuffixLike } from "@/lib/ai/web-tasks";

import { nonEmptyString, nonNegativeNumber, positiveInt, regexString } from "./common";

/** A role family id / deep link id: lower-case snake_case. */
const slugId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "must be lower-case snake_case (letters, digits, _), at most 40");
const label = z
  .strictObject({ en: nonEmptyString.max(60).optional(), zh: nonEmptyString.max(60).optional() })
  .refine((value) => value.en !== undefined || value.zh !== undefined, "needs a name in at least one language");

/** A host name for `lookup.allowed_fetch_domains` (lower case, at least one dot; no scheme, path or wildcard; one site, not a public suffix). */
const domain = z
  .string()
  .regex(/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/, "must be a lower-case host name such as levels.fyi")
  .refine((value) => !isPublicSuffixLike(value), "must name one site, not a public suffix such as co.uk or github.io");

/** Placeholders a deep link template may use; each is URL-encoded when it is filled in. */
export const DEEP_LINK_PLACEHOLDERS = ["company", "company_slug", "title", "city", "country"] as const;

const deepLinkUrl = z
  .string()
  .trim()
  .refine((value) => {
    const filled = value.replace(/\{[a-z_]+\}/g, "x");
    try {
      const url = new URL(filled);
      return url.protocol === "https:" || url.protocol === "http:";
    } catch {
      return false;
    }
  }, "must be an http(s) URL (placeholders in braces)")
  .refine(
    (value) => [...value.matchAll(/\{([a-z_]+)\}/g)].every((match) => (DEEP_LINK_PLACEHOLDERS as readonly string[]).includes(match[1] ?? "")),
    `may only use the placeholders ${DEEP_LINK_PLACEHOLDERS.map((name) => `{${name}}`).join(", ")}`,
  );

const roleFamily = z.strictObject({
  id: slugId,
  label,
  /** Regular expressions on the job title (flags "iu"); the first family with a matching pattern wins. */
  patterns: z.array(regexString).min(1),
});

const deepLink = z.strictObject({
  id: slugId,
  /** Shown on the link (a site name, not translated). */
  label: nonEmptyString.max(40),
  url: deepLinkUrl,
});

const unique = <T>(items: readonly T[], key: (item: T) => string): boolean => new Set(items.map(key)).size === items.length;

/** config/salary.yaml: the salary benchmark built from the collected postings, deep links, and the on-demand AI lookup. */
export const salarySchema = z.strictObject({
  benchmark: z.strictObject({
    /** false: the pipeline step does not rebuild the benchmark (the stored one stays, the card still reads it). */
    enabled: z.boolean(),
    /** Only postings first seen in the last this many days count. */
    window_days: positiveInt,
    /** A group (family x seniority x place) with fewer figures than this is not stored; the card falls back to a wider group. */
    min_sample: positiveInt,
    /**
     * Also count the bands of finished AI lookups (base salary, confidence medium or high, with a source, place and
     * seniority checked against the job, one per lookup). Off by default: estimates are kept apart from posting facts.
     */
    include_ai_lookups: z.boolean().default(false),
  }),
  role_families: z
    .array(roleFamily)
    .max(50)
    .refine((items) => unique(items, (item) => item.id), "role family ids must not contain duplicates"),
  deep_links: z
    .array(deepLink)
    .max(10)
    .refine((items) => unique(items, (item) => item.id), "deep link ids must not contain duplicates"),
  lookup: z.strictObject({
      /** The "look up salary" button on the job page (AI with web search, costs tokens). Off by default. */
      enabled: z.boolean(),
      /** A lookup for the same company, role, seniority and place is shown from the cache for this many days. */
      ttl_days: positiveInt,
      /** Most lookups queued per 24 hours (a cached answer does not count). */
      max_per_day: positiveInt,
      /** One lookup (every provider and retry together) may take this many seconds. */
      timeout_seconds: positiveInt,
      /** Most web searches one lookup may make (enforced for the Anthropic API; the CLIs are asked to keep to it). */
      max_searches: positiveInt.max(20),
      /**
       * Hosts the Claude CLI may fetch pages from (pre-approved; anything else is denied by the CLI) and the Anthropic API
       * may take search results from. Source links on other hosts are shown as "other source".
       */
      allowed_fetch_domains: z.array(domain).max(30).refine((items) => new Set(items).size === items.length, "must not contain duplicates"),
      /** Figures outside this range (per year, in the market's base currency) are dropped as implausible. */
      sanity_annual: z.strictObject({ min: nonNegativeNumber, max: nonNegativeNumber }).refine((range) => range.min < range.max, "min must be below max"),
      /** A figure in a currency with no exchange rate (kept only in its own currency) above this is dropped as implausible. Loose on purpose: some currencies count in the tens of thousands per euro. */
      unconvertible_max_annual: positiveInt.default(100_000_000_000),
      /** USD per web search of the Anthropic API (counted in ai_usage and the monthly API budget). */
      web_search_usd: nonNegativeNumber.default(0.01),
    }),
});

export type SalaryConfig = z.infer<typeof salarySchema>;
export type RoleFamilyConfig = SalaryConfig["role_families"][number];
export type DeepLinkConfig = SalaryConfig["deep_links"][number];
