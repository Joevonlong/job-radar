import { z } from "zod";

import type { SearchConfig } from "@/lib/config";

import type { CycleKind } from "@/lib/db/repos/cycles";

/**
 * Channel framework contracts. Every collection channel implements
 * `Channel` and registers itself; the framework owns scheduling, throttling, retries, budgets,
 * circuit breaking, cascading and raw persistence.
 */

export const CHANNEL_FAMILIES = [
  "linkedin",
  "indeed",
  "stepstone",
  "xing",
  "arbeitsagentur",
  "arbeitnow",
  "google",
  "ats",
  "email",
  "manual",
] as const;
export type ChannelFamily = (typeof CHANNEL_FAMILIES)[number];

export const CHANNEL_KINDS = ["paid", "session", "guest", "api", "ats", "browser", "email", "manual"] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

// ---------------------------------------------------------------- queries

/** `search.yaml: remote_scope` without `none` (no remote queries are built for `none`). */
export type RemoteScope = Exclude<SearchConfig["remote_scope"], "none">;

export interface SearchQuery {
  /** Stable hash of what is searched (keywords, group, location, remote); see `queryId`. */
  id: string;
  /** One OR-group: a posting matches if it matches any of these. */
  keywords: string[];
  /** Id of the group in search.yaml (`*` for the board-sweep query of channels that ignore keywords). */
  keywordGroup: string;
  /** City, or null for the remote query. */
  location: string | null;
  remote: boolean;
  /** Region a remote posting must be open to (`search.yaml: remote_scope`); null for located queries. */
  remoteScope: RemoteScope | null;
  /** Look-back window of this cycle. */
  windowHours: number;
  /** Upper bound for this query (already capped by the channel's own `max_results`). */
  maxResults: number;
}

// ---------------------------------------------------------------- raw postings (C1)

/** Whether `value` survives `JSON.stringify` → `JSON.parse` (no BigInt, cycles, undefined, functions at the root). */
export function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

export const rawPostingInputSchema = z.object({
  /** Id of the posting within its channel; (channel, externalId) is unique in `raw_postings`. */
  externalId: z.string().trim().min(1, "externalId must not be empty"),
  url: z.string().nullable(),
  /** The posting exactly as the source delivered it. Must be JSON-serializable. */
  payload: z.unknown().refine(isJsonSerializable, "payload must be JSON-serializable"),
  /** Publication time when the source gives one. A hint for the pipeline; not stored separately. */
  postedAt: z.date().nullable().optional(),
});
export type RawPostingInput = z.infer<typeof rawPostingInputSchema>;

// ---------------------------------------------------------------- normalized drafts

const optionalText = z.string().nullable().optional();

export const WORKPLACES = ["onsite", "hybrid", "remote", "unknown"] as const;
export const SALARY_PERIODS = ["year", "month", "week", "day", "hour"] as const;

export const postingLocationSchema = z.object({
  /** The location as the posting words it. */
  label: z.string().trim().min(1),
  city: z.string().trim().min(1).nullable(),
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: z
    .string()
    .regex(/^[A-Z]{2}$/, "countryCode must be ISO 3166-1 alpha-2, upper case")
    .nullable(),
});

export const postingSalarySchema = z
  .object({
    /** null when the posting only gives an upper bound ("up to 120k"). */
    min: z.number().nonnegative().nullable(),
    max: z.number().nonnegative().nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/, "currency must be an ISO 4217 code"),
    period: z.enum(SALARY_PERIODS),
    /** The salary text this was derived from. */
    raw: z.string(),
  })
  .refine((s) => s.min !== null || s.max !== null, { message: "salary needs a min or a max" })
  .refine((s) => s.min === null || s.max === null || s.min <= s.max, { message: "salary min must be <= max" });

const httpUrl = z.url({ protocol: /^https?$/ });

/**
 * What a channel's `parse` returns (C6: validated by the pipeline before use).
 * Facts the posting does not state are `unknown` / null, never guessed (C3).
 */
export const normalizedPostingDraftSchema = z.object({
  title: z.string().trim().min(1),
  companyName: z.string().trim().min(1),
  locations: z.array(postingLocationSchema),
  workplace: z.enum(WORKPLACES),
  contractHint: optionalText,
  seniorityHint: optionalText,
  salaryText: optionalText,
  salary: postingSalarySchema.nullable().optional(),
  /** Plain text or Markdown. */
  description: z.string(),
  /** ISO 639-1 code or "unknown". */
  descriptionLanguage: z.string().min(2).optional(),
  postedAt: z.date().nullable().optional(),
  applyUrl: httpUrl.nullable(),
  sourceUrl: httpUrl.nullable(),
  /** The poster is a recruiter / staffing agency rather than the employer. */
  isAgency: z.boolean().optional(),
  /** Channel-specific leftovers that do not fit the common shape. */
  extra: z.record(z.string(), z.unknown()).optional(),
});
export type NormalizedPostingDraft = z.infer<typeof normalizedPostingDraftSchema>;

// ---------------------------------------------------------------- errors, budget, logging

export const CHANNEL_ERROR_CODES = [
  "rate_limited",
  "blocked",
  "auth_expired",
  "budget_exceeded",
  "network",
  "parse",
  "unknown",
] as const;
export type ChannelErrorCode = (typeof CHANNEL_ERROR_CODES)[number];

export interface ChannelLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** A logger that adds `fields` to every line. */
  child(fields: Record<string, unknown>): ChannelLogger;
}

export interface HttpRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Extra cancellation on top of the cycle's signal. */
  signal?: AbortSignal;
  /** Statuses (e.g. 404 for "board does not exist") returned to the caller instead of raising a ChannelError. */
  allowStatus?: readonly number[];
  /** Overrides `http.max_retries` for this request. */
  maxRetries?: number;
  /** Overrides `http.timeout_ms` for this request (slow upstreams such as the jobspy sidecar). */
  timeoutMs?: number;
  /**
   * `error`: a redirect fails the request instead of being followed (requests that carry an API key: the key must not follow it elsewhere).
   * `manual`: the 3xx response is handed back with its `Location` header, so the caller can check every hop (URLs that came from data).
   */
  redirect?: "error" | "follow" | "manual";
}

/** The subset of `Response` the framework relies on (so tests can fake it). */
export interface HttpResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Discard an unused body and release its request timeout / cancellation listeners; absent on fakes. */
  cancel?(): Promise<void>;
  /** The body as text, at most `maxBytes` of it (the rest is not downloaded); absent on fakes, which callers read with `text()`. */
  textUpTo?(maxBytes: number): Promise<{ text: string; truncated: boolean }>;
  /** The raw body stream of a real `fetch` response (read by `textUpTo`). */
  readonly body?: ReadableStream<Uint8Array> | null;
}

export interface HttpClient {
  /** Resolves for 2xx/3xx and `allowStatus` statuses; otherwise throws a classified `ChannelError`. */
  request(url: string, init?: HttpRequestInit): Promise<HttpResponse>;
  /** GET/POST + JSON body parsed and validated (C6). A shape mismatch throws `ChannelError("parse")`. */
  json<S extends z.ZodType>(url: string, schema: S, init?: HttpRequestInit): Promise<z.infer<S>>;
}

export interface BudgetSnapshot {
  /** Calendar month `YYYY-MM` the numbers refer to. */
  month: string;
  /** Records this channel consumed this month. */
  records: number;
  /** USD this channel spent this month. */
  usd: number;
  /** Free records left (`free_records_per_month` minus used, never negative). */
  freeRecordsLeft: number;
  /** USD the channel may still spend: the smaller of its own budget and what is left of the global cap. */
  usdLeft: number;
}

export interface ChannelBudget {
  snapshot(): BudgetSnapshot;
  /** Would consuming `records` stay within the channel budget and the global paid cap? */
  canAfford(records: number, costUsd?: number): boolean;
  /**
   * Count `records` against this month's usage. Records inside the free allowance cost nothing; the
   * rest cost `costUsd` when given (actual billing), otherwise `channel.estimateCost(paidRecords)`.
   * Throws `BudgetExceededError` — and records nothing — if that would exceed the channel budget or
   * `paid_total_monthly_budget_usd`. Call it before the billable request.
   * `allowOverspend` is for usage the provider has ALREADY billed: it is recorded in full even when it
   * exceeds a budget (billed usage is never dropped); the channel then has no headroom left, so the
   * cascade moves on for later queries.
   */
  consume(records: number, options?: { costUsd?: number; allowOverspend?: boolean }): Promise<{ usd: number; freeRecords: number; paidRecords: number }>;
}

export interface ChannelRuntimeSettings {
  /** `enabled` in sources.yaml and the channel serves the current market. */
  readonly enabled: boolean;
  /** The channel serves only other markets (`markets` without the home country): left out, not a failure. */
  readonly otherMarket?: boolean;
  /** `markets` of sources.yaml; empty = every market. */
  readonly markets?: readonly string[];
  /** Result cap per query from sources.yaml (`max_results`). */
  readonly maxResults: number;
  readonly monthlyBudgetUsd: number;
  readonly freeRecordsPerMonth: number;
  readonly throttle: { readonly minDelayMs: number; readonly maxDelayMs: number };
  /** The channel's raw config block, for channel-specific keys (e.g. `actor_id`). */
  readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * Postings this channel already stored. A channel that reads one page or request per posting uses it to skip
 * the detail fetch of known postings and re-deliver the stored detail instead.
 */
export interface KnownPostings {
  /** Stored payloads (`raw_postings.payload_json`) of this channel by external id; ids it does not hold are absent. Throws on a lookup failure. */
  payloads(externalIds: readonly string[]): Promise<Map<string, unknown>>;
}

export interface ChannelContext {
  http: HttpClient;
  /** Wait a random delay within the channel's throttle range (call between requests). */
  throttle(): Promise<void>;
  budget: ChannelBudget;
  /** Aborted when the cycle is cancelled (runner shutdown). Honour it in long loops. */
  signal: AbortSignal;
  /** Structured logger; never log secrets, headers or full URLs with query strings. */
  logger: ChannelLogger;
  /** `id` is null for dry runs, which write nothing. */
  cycle: { id: number | null; kind: CycleKind };
  settings: ChannelRuntimeSettings;
  /** Already stored postings of this channel. Empty in dry runs without a database and in tests that do not seed it. */
  known: KnownPostings;
}

// ---------------------------------------------------------------- the channel

/** One HTML part of a payload: its field path (`posting.content`), the markup, and whether the markup is entity-escaped. */
export interface DescriptionHtmlFragment {
  path: string;
  html: string;
  escaped?: boolean;
}

export interface Channel {
  /** Unique id, e.g. `linkedin-brightdata`. Must be known to the registry's config table. */
  readonly id: string;
  readonly family: ChannelFamily;
  readonly kind: ChannelKind;
  /** false for channels that ignore keyword queries and iterate their own boards (ATS). */
  readonly usesQueries: boolean;
  /**
   * Fetch postings for one query. Must return every posting verbatim (C1). Throw `ChannelError`
   * (or let `ctx.http` throw) for failures; other thrown values are classified as `unknown`.
   */
  collect(query: SearchQuery, ctx: ChannelContext): Promise<RawPostingInput[]>;
  /** Turn one raw payload into the normalized shape. Called by the pipeline; throws `ChannelError("parse")` on bad input. */
  parse(payload: unknown): NormalizedPostingDraft;
  /**
   * The HTML parts of a stored payload the description is made from, for the AI trap scan (hidden text, comments,
   * attributes). Reads the payload only (C1); returns `[]` when the payload does not match. Omit for channels that keep no HTML.
   */
  descriptionHtml?(payload: unknown): DescriptionHtmlFragment[];
  /**
   * The ghost job check: one posting keeps one `external_id` on this channel, so a new id for the same job is a relisting. Omit for
   * channels whose ids change between fetches or come from another id space (search aggregators, e-mail alerts).
   */
  readonly stableExternalIds?: boolean;
  /** The ghost job check: the channel stores the posting's full text, not a snippet, so a short JD says something about the employer. */
  readonly fullDescription?: boolean;
  /** The ghost job check: the posted date `parse` returns is the source's own (an ATS's publish date), not a guess or an aggregator's. */
  readonly trustedPostedAt?: boolean;
  /**
   * The ghost job check: the source's own "reposted" label of a stored payload ("Reposted 2 weeks ago"), or null. Reads the payload
   * only (C1) and returns null when it does not match. Omit for channels without such a label.
   */
  repostLabel?(payload: unknown): string | null;
  /** USD for `paidRecords` billable records; omit for free channels. */
  estimateCost?(paidRecords: number): number;
  /**
   * false while the channel lacks what it needs to run at all (an API token, an actor id). The cascade then skips it
   * ("not configured") without a failed run or a circuit-breaker strike. Omit for channels that need nothing.
   */
  isConfigured?(): boolean;
  /**
   * Whether the channel should run in this cycle at all (a daily side channel that already ran today is not due). The cycle then
   * leaves the channel out entirely: no run row, no "skipped" noise. Omit for channels that run every cycle. A throw counts as "due".
   */
  isDue?(info: { kind: CycleKind; now: Date; dryRun: boolean }): boolean | Promise<boolean>;
}
