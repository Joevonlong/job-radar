import { z } from "zod";

import { CHANNEL_KINDS } from "@/lib/channels/types";

import { atsBoardsSchema } from "./companies";
import { nonEmptyString, nonNegativeInt, nonNegativeNumber, positiveInt, stringList } from "./common";

/** The remote query's location per remote scope kind (`home_country`, `region`, `worldwide`); a missing key follows the market. */
const remoteLocations = z
  .strictObject({ home_country: z.string().trim().optional(), region: z.string().trim().optional(), worldwide: z.string().trim().optional() })
  .default({});

const throttle = z
  .strictObject({
    min_delay_ms: nonNegativeInt,
    max_delay_ms: nonNegativeInt,
  })
  .refine((t) => t.min_delay_ms <= t.max_delay_ms, {
    message: "min_delay_ms must be <= max_delay_ms",
    path: ["min_delay_ms"],
  });

/** Settings every channel has. */
const baseShape = {
  enabled: z.boolean(),
  /**
   * The markets (home countries, ISO 3166-1 alpha-2) the channel serves; missing = every market. Under another
   * market the channel is left out of the cycle (not a failure, C2) and shown as "other market".
   */
  markets: z.array(z.string().regex(/^[A-Z]{2}$/, "must be an ISO 3166-1 alpha-2 code, upper case")).min(1).optional(),
  /** Paid budget per calendar month in USD. 0 = no paid usage allowed. */
  monthly_budget_usd: nonNegativeNumber,
  throttle,
  max_results: positiveInt,
};

const channel = z.strictObject(baseShape);

/** `sources.arbeitsagentur`: Bundesagentur für Arbeit Jobsuche API. */
export const arbeitsagenturSettingsSchema = z.strictObject({
  ...baseShape,
  /** Jobsuche service root; the channel appends the search and job-detail paths. */
  base_url: z.url({ protocol: /^https?$/ }),
  /** Public client key the API asks for in `X-API-Key` (not a secret; published in the BA API docs). */
  api_key: z.string().trim().min(1, "must not be empty"),
  /** Search radius around each configured city, in km. */
  radius_km: positiveInt,
  /** Postings per search page. */
  page_size: positiveInt,
  /** Fetch each posting's detail record (job description) after the search. */
  fetch_details: z.boolean(),
  /** Most detail requests per search query; postings beyond it keep their list data only. */
  max_details_per_query: nonNegativeInt,
  /** Postings already stored keep their stored detail instead of fetching it again. */
  reuse_known_details: z.boolean(),
  /**
   * Remote queries search all of Germany; keep only postings that say home office is possible
   * (`homeofficemoeglich`). false keeps every posting of the Germany-wide search.
   */
  remote_requires_home_office: z.boolean(),
  /** Most search pages scanned per keyword for a remote query when filtering (most hits are on-site). */
  remote_max_pages: positiveInt,
});
export type ArbeitsagenturSettings = z.infer<typeof arbeitsagenturSettingsSchema>;

const httpBaseUrl = z.url({ protocol: /^https?$/ });

/**
 * Title prefilter of the ATS channels: a board returns every open posting, so only titles
 * that match a search.yaml keyword (or belong to a watched company) are stored.
 */
const atsTitlePrefilter = z.strictObject({
  /** false = store every posting of every board. */
  enabled: z.boolean(),
  /** Extra title terms that keep a posting, on top of the search.yaml keywords (word-boundary, case-insensitive). */
  include_terms: stringList,
  /** Title terms that drop a posting even if a keyword matches (word-boundary, case-insensitive). Never applied to watched companies. */
  exclude_terms: stringList,
});

const greenhouseChannel = z.strictObject({
  ...baseShape,
  /** Public Job Board API host (sources.yaml `ats_boards[].token` is the board slug). */
  api_base_url: httpBaseUrl,
  title_prefilter: atsTitlePrefilter,
});

const leverChannel = z.strictObject({
  ...baseShape,
  /** Global postings API host. */
  api_base_url: httpBaseUrl,
  /** EU postings API host, used by companies whose ats_boards entry says `region: eu`. */
  eu_api_base_url: httpBaseUrl,
  title_prefilter: atsTitlePrefilter,
});

const ashbyChannel = z.strictObject({
  ...baseShape,
  /** Public posting API host (sources.yaml `ats_boards[].token` is the job board name). */
  api_base_url: httpBaseUrl,
  /** Ask for `includeCompensation=true`: postings then carry their salary range. */
  include_compensation: z.boolean(),
  title_prefilter: atsTitlePrefilter,
});

const personioChannel = z.strictObject({
  ...baseShape,
  /** Career site of a company; `{token}` is replaced by the sources.yaml `ats_boards[].token` (the company's Personio sub-domain). The feed is `<site>/xml`. */
  api_base_url: z
    .string()
    .trim()
    .refine((value) => value.includes("{token}") && httpBaseUrl.safeParse(value.replace("{token}", "x")).success, {
      message: "must be an http(s) URL containing {token}",
    }),
  /** Language of the feed (`?language=`). Personio answers in the company's default language when it has no translation. */
  language: z.enum(["en", "de"]),
  title_prefilter: atsTitlePrefilter,
});

const smartrecruitersChannel = z.strictObject({
  ...baseShape,
  /** Public posting API host (sources.yaml `ats_boards[].token` is the company identifier, case-sensitive). */
  api_base_url: httpBaseUrl,
  /** ISO 3166-1 alpha-2 country the postings are filtered by (big boards list the whole world); empty = every country, missing = the market's home country. */
  country: z.string().regex(/^([a-z]{2})?$/, "must be a lower-case ISO 3166-1 alpha-2 code, or empty").optional(),
  /** Postings per list request (the API allows at most 100). */
  page_size: positiveInt.max(100),
  /** The list lacks the description: fetch details for kept postings, subject to the failure limit. */
  fetch_details: z.boolean(),
  /**
   * Failures in a row allowed per board per sweep; after that, remaining details are not requested
   * this sweep. Stored postings keep their stored version; new ones are retried next sweep.
   */
  max_consecutive_detail_failures: positiveInt.default(3),
  title_prefilter: atsTitlePrefilter,
});

/** `sources.brave`: web-search discovery of new ATS boards. The API key comes from `BRAVE_SEARCH_API_KEY`. */
const braveChannel = z.strictObject({
  ...baseShape,
  /** Brave Search API host. */
  api_base_url: httpBaseUrl,
  /** Country the search is localised to (ISO 3166-1 alpha-2, upper case); empty or missing = the market's home country. */
  country: z.string().regex(/^(?:[A-Z]{2})?$/, "must be an ISO 3166-1 alpha-2 code, upper case, or empty").optional(),
  /** Brave `safesearch`. */
  safesearch: z.enum(["off", "moderate", "strict"]),
  /** Do not search again before this many hours have passed since the last discovery run. */
  interval_hours: positiveInt,
  /** Most searches per discovery run (ATS x keyword group x city can add up; the free plan allows 2000 a month). */
  max_queries_per_run: positiveInt,
});

/** `sources.tavily`: web-search discovery of new ATS boards through Tavily. The API key comes from `TAVILY_API_KEY`. */
const tavilyChannel = z.strictObject({
  ...baseShape,
  /** Tavily answers at most 20 results per request. */
  max_results: positiveInt.max(20),
  /** Tavily API host. */
  api_base_url: httpBaseUrl,
  /** `basic` / `fast` / `ultra-fast` cost 1 credit per search, `advanced` 2. */
  search_depth: z.enum(["basic", "advanced", "fast", "ultra-fast"]),
  /** How many keywords of each search.yaml group go into one query (Tavily has no `site:` operator, so the query is plain words). */
  keywords_per_query: positiveInt,
  /** Do not search again before this many hours have passed since the last discovery run. */
  interval_hours: positiveInt,
  /** Most searches per discovery run (ATS x keyword group x city). */
  max_queries_per_run: positiveInt,
  /** Credits the Tavily plan includes per month (free plan: 1000); the channel stops searching when they are used up. */
  monthly_credit_limit: positiveInt,
  /** USD per credit beyond `monthly_credit_limit` (pay-as-you-go: 0.008); 0 = nothing is searched beyond the limit. Counted against `monthly_budget_usd`. */
  credit_cost_usd: nonNegativeNumber,
});

/**
 * Settings the two job-board channels share: both read public search pages over plain HTTP
 * (embedded JSON, no browser), so they are throttled by `throttle` and capped per query by `max_pages`.
 */
const jobBoardShape = {
  ...baseShape,
  /** Site root; the channel appends the search and posting paths. */
  base_url: httpBaseUrl,
  /** Sent as the `User-Agent` of every request. */
  user_agent: nonEmptyString,
  /** Search radius around each configured city, in km. */
  radius_km: positiveInt,
  /** Most result pages read per keyword (one request each). */
  max_pages: positiveInt,
  /** Fetch each selected posting's page (the job description is only there). */
  fetch_details: z.boolean(),
  /** Most detail requests per search query; postings beyond it keep their list data only. */
  max_details_per_query: nonNegativeInt,
  /** Postings already stored keep their stored detail instead of fetching it again. */
  reuse_known_details: z.boolean(),
  /** Search results are loose matches: only titles that match a query keyword or an include term are kept (see the ATS prefilter). */
  title_prefilter: atsTitlePrefilter,
};

/** `sources.stepstone`: www.stepstone.de search result pages + posting pages. */
export const stepstoneSettingsSchema = z.strictObject(jobBoardShape);
export type StepstoneSettings = z.infer<typeof stepstoneSettingsSchema>;

/** `sources.xing`: www.xing.com/jobs search pages + posting pages. */
export const xingSettingsSchema = z.strictObject({
  ...jobBoardShape,
  /** Id of XING's "fully remote" filter value (`remoteOption` in the search URL); it carries a hash suffix that XING can change. */
  remote_option_id: nonEmptyString,
});
export type XingSettings = z.infer<typeof xingSettingsSchema>;

/**
 * `sources.arbeitnow`: the free public Arbeitnow Job Board API. It has no keyword or location parameters, so the
 * channel reads the newest pages of the whole board and keeps titles that pass the title prefilter (like an ATS board).
 */
export const arbeitnowSettingsSchema = z.strictObject({
  ...baseShape,
  /** Site root; the channel appends the API path (`/api/job-board-api`). */
  base_url: httpBaseUrl,
  /** Sent as the `User-Agent` of every request. */
  user_agent: nonEmptyString,
  /** Most pages read per sweep (one request each); paging also stops at a page whose newest posting is older than the look-back window. */
  max_pages: positiveInt,
  /** The board returns every posting: only titles that match a search.yaml keyword or an include term (or a watched company) are stored. */
  title_prefilter: atsTitlePrefilter,
});
export type ArbeitnowSettings = z.infer<typeof arbeitnowSettingsSchema>;

/**
 * `sources.jsearch`: JSearch (Google for Jobs) on RapidAPI. The API key comes from `JSEARCH_API_KEY`.
 * The RapidAPI plan counts requests: `monthly_request_limit` mirrors the plan's included requests and is
 * what the channel's usage is booked against (records = requests).
 */
const jsearchChannel = z.strictObject({
  ...baseShape,
  /** RapidAPI host of JSearch; its host name is also sent as `X-RapidAPI-Host`. */
  api_base_url: httpBaseUrl,
  /** Country the search is localised to (`country=`; ISO 3166-1 alpha-2, lower case); empty or missing = the market's home country. */
  country: z.string().regex(/^(?:[a-z]{2})?$/, "must be a lower-case ISO 3166-1 alpha-2 code, or empty").optional(),
  /** `language=` (ISO 639-1, lower case); empty = the country's primary language. */
  language: z.string().regex(/^([a-z]{2})?$/, "must be a lower-case ISO 639-1 code, or empty"),
  /** `num_pages`: result pages (10 postings each) one query reads; every page costs one request. */
  pages_per_query: positiveInt.max(20),
  /** How many keywords of a search.yaml group get their own query (in file order; one request each, so mind the monthly limit). */
  keywords_per_query: positiveInt,
  /** Requests the RapidAPI plan includes per month (free plan: 200); the channel stops sending when they are used up. */
  monthly_request_limit: positiveInt,
  /** USD per request beyond `monthly_request_limit` (paid plans); 0 = no request beyond the limit is sent. Counted against `monthly_budget_usd`. */
  overage_cost_per_request_usd: nonNegativeNumber,
  /** Spread `monthly_request_limit` evenly over the month, so a few early cycles cannot use it all up. */
  pace_requests: z.boolean(),
  /** Fetch `/job-details` for postings whose search result has no description (one request per posting). */
  fetch_details: z.boolean(),
  /** Most detail lookups per search query. */
  max_details_per_query: nonNegativeInt,
  /** Apply-link order among non-direct links (publisher names, case-insensitive); links of other publishers come after. */
  apply_publisher_preference: stringList,
  /** Extra attempts after a per-second / per-minute rate-limit answer (429), each after the channel's throttle delay. A monthly-quota answer is never retried. */
  rate_limit_retries: nonNegativeInt,
});

export type AtsTitlePrefilterSettings = z.infer<typeof atsTitlePrefilter>;
export type GreenhouseChannelSettings = z.infer<typeof greenhouseChannel>;
export type LeverChannelSettings = z.infer<typeof leverChannel>;
export type AshbyChannelSettings = z.infer<typeof ashbyChannel>;
export type PersonioChannelSettings = z.infer<typeof personioChannel>;
export type SmartrecruitersChannelSettings = z.infer<typeof smartrecruitersChannel>;
export type BraveChannelSettings = z.infer<typeof braveChannel>;
export type TavilyChannelSettings = z.infer<typeof tavilyChannel>;
export type JsearchSettings = z.infer<typeof jsearchChannel>;
export {
  ashbyChannel as ashbyChannelSchema,
  braveChannel as braveChannelSchema,
  tavilyChannel as tavilyChannelSchema,
  greenhouseChannel as greenhouseChannelSchema,
  jsearchChannel as jsearchSettingsSchema,
  leverChannel as leverChannelSchema,
  personioChannel as personioChannelSchema,
  smartrecruitersChannel as smartrecruitersChannelSchema,
};

/** Platforms whose job-alert emails the Gmail channel can parse. */
export const GMAIL_PLATFORMS = ["linkedin", "stepstone", "indeed", "xing"] as const;
export type GmailPlatform = (typeof GMAIL_PLATFORMS)[number];

const senderDomains = z
  .array(z.string().trim().toLowerCase().regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, "must be a bare domain such as linkedin.com"))
  .min(1);

/** `sources.gmail`: job-alert emails read over IMAP. Credentials come from `GMAIL_USER` / `GMAIL_APP_PASSWORD`. */
export const gmailSettingsSchema = z.strictObject({
  ...baseShape,
  host: nonEmptyString,
  port: positiveInt,
  /** Implicit TLS (port 993). false = plain connection, only for a local test server. */
  secure: z.boolean(),
  /** Gmail label (= IMAP mailbox) holding the alert emails; opened read-only. */
  label: nonEmptyString,
  /** Most emails read per cycle (newest first); the rest wait for the next cycle. */
  max_messages_per_cycle: positiveInt,
  /** Only emails received within this many days are considered. */
  lookback_days: positiveInt,
  /** Connection, greeting and socket timeout. */
  timeout_ms: positiveInt,
  /** Sender domains (the part after @, subdomains included) that select each platform's parser. */
  senders: z.strictObject({
    linkedin: senderDomains,
    stepstone: senderDomains,
    indeed: senderDomains,
    xing: senderDomains,
  }),
});
export type GmailSettings = z.infer<typeof gmailSettingsSchema>;

/** Resource types Playwright can block (`Request.resourceType()`). */
export const BLOCKABLE_RESOURCE_TYPES = ["document", "stylesheet", "image", "media", "font", "script", "texttrack", "xhr", "fetch", "eventsource", "websocket", "manifest", "other"] as const;

/**
 * `linkedin.session`: LinkedIn through the user's own logged-in browser session. The login state lives in `site.auth_file`
 * (written by `pnpm auth:linkedin`, never committed); the channel only reads pages.
 */
export const sessionSettingsSchema = z.strictObject({
  ...baseShape,
  /** Run the "recommended for you" side channel (`linkedin-session:recommended`) once a day. */
  recommended_daily: z.boolean(),
  /** Most postings the "recommended for you" run reads. */
  recommended_max_results: positiveInt,
  /** LinkedIn pages (search, detail, recommended) loaded per calendar day in the schedule's time zone, all session channels together. */
  daily_request_limit: positiveInt,
  /** Most search result pages read per query (about 25 postings each). */
  max_pages: positiveInt,
  /** Open each new posting's page for the description, salary, work mode and applicant count. */
  fetch_details: z.boolean(),
  site: z.strictObject({
    base_url: httpBaseUrl,
    /** Playwright storage state written by `pnpm auth:linkedin`; relative to the working directory. */
    auth_file: nonEmptyString,
    /** Country name appended to a city for located queries (`Berlin, Germany`); empty or missing = the market's home country. */
    country_name: z.string().trim().optional(),
    /** `location` of the remote query per remote scope kind; a missing key follows the market. */
    remote_locations: remoteLocations,
  }),
  browser: z.strictObject({
    headless: z.boolean(),
    /** Abort a page load after this long. */
    navigation_timeout_ms: positiveInt,
    /** Wait after a page loaded for the single-page app to render. */
    render_wait_ms: nonNegativeInt,
    /** Scroll steps that load the lazily rendered cards of a result list. */
    scroll_steps: nonNegativeInt,
    scroll_pause_ms: nonNegativeInt,
    /** Browser language (`en-US`): LinkedIn words its pages (and relative times) accordingly. */
    locale: z.string().trim().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/, "must be a locale such as en-US"),
    /** Resource types that are not loaded (images, fonts, media). */
    block_resources: z.array(z.enum(BLOCKABLE_RESOURCE_TYPES)),
    /** Empty = the browser's own User-Agent. */
    user_agent: z.string().trim(),
  }),
});
export type SessionSettings = z.infer<typeof sessionSettingsSchema>;

export const LINKEDIN_CHANNEL_IDS = [
  "linkedin-brightdata",
  "linkedin-apify",
  "linkedin-session",
  "linkedin-guest",
] as const;

const linkedinChannelId = z.enum(LINKEDIN_CHANNEL_IDS);

/** Fetch wrapper defaults handed to every channel (ChannelContext.http). */
const httpSettings = z.strictObject({
  /** Abort a single request after this long. */
  timeout_ms: positiveInt,
  /** Retries after the first attempt (network errors, 5xx, 429). 0 disables retrying. */
  max_retries: nonNegativeInt,
  /** First backoff delay; doubles per retry, with jitter. */
  backoff_base_ms: positiveInt,
  /** Upper bound for one backoff delay and for an honoured Retry-After. */
  backoff_max_ms: positiveInt,
});

/** The python-jobspy sidecar shared by `linkedin-guest`, `indeed` and `jobspy-google`. */
const jobspySettings = z.strictObject({
  /** Base URL of the sidecar. The `JOBSPY_URL` environment variable overrides it (compose sets it for the runner). */
  url: z.url({ protocol: /^https?$/ }),
  /** Per-request timeout: a scrape with description fetching takes far longer than a normal API call. */
  timeout_ms: positiveInt,
  /** Indeed country site (`germany` → de.indeed.com); jobspy's own country names. Empty or missing = the market's home country. */
  country_indeed: z.string().trim().optional(),
  /** Ask the sidecar for LinkedIn job descriptions (one extra request per posting; raises the 429 risk). */
  linkedin_fetch_description: z.boolean(),
  /** Location searched for remote queries, per remote scope kind; empty = no location filter, missing = follow the market. */
  remote_location: z.strictObject({ home_country: z.string().optional(), region: z.string().optional(), worldwide: z.string().optional() }).default({}),
  /** Proxy URLs handed to jobspy (round-robin). Empty = direct. These may carry credentials: keep this file private. */
  proxies: z.array(z.string().trim().min(1)),
});

/** config/sources.yaml (config name `channels`) — channel switches, cascade, throttling, budgets. */
/** The "test" button of a channel on /sources: one small dry fetch, nothing stored. */
const testChannel = z.strictObject({
  /** Most postings the test asks for (the channel's own `max_results` still applies when it is lower). */
  max_results: positiveInt,
  /** Board-discovery channels (tavily, brave): searches the test may send (their own `max_queries_per_run` still applies when it is lower). */
  max_queries: positiveInt.default(1),
  /** The test is aborted after this long. */
  timeout_seconds: positiveInt,
  /** Channel kinds without a test: paid ones bill every record, the LinkedIn session has a daily page limit. */
  excluded_kinds: z.array(z.enum(CHANNEL_KINDS)).refine((xs) => new Set(xs).size === xs.length, "must not contain duplicates"),
});

export type TestChannelConfig = z.infer<typeof testChannel>;

const TEST_CHANNEL_DEFAULTS: TestChannelConfig = { max_results: 5, max_queries: 1, timeout_seconds: 120, excluded_kinds: ["paid", "session"] };

const BOARD_PAGE_URL_DEFAULTS = {
  greenhouse: "https://job-boards.greenhouse.io/{token}",
  lever: "https://jobs.lever.co/{token}",
  lever_eu: "https://jobs.eu.lever.co/{token}",
  ashby: "https://jobs.ashbyhq.com/{token}",
  personio: "https://{token}.jobs.personio.de",
  smartrecruiters: "https://jobs.smartrecruiters.com/{token}",
};

const boardPageUrl = z.string().refine((v) => v.includes("{token}"), "must contain {token}");

/** The `registry` block of config/sources.yaml: window, board verdict thresholds, import limit, career page URLs. */
export const registrySettingsSchema = z.strictObject({
  /** "Last N days" window of the registry page and `pnpm sources:list`. */
  window_days: positiveInt,
  /** Consecutive failures after which an ATS board counts as failing (fewer = unstable). */
  board_failing_after: positiveInt,
  /** An enabled board not checked for this many hours counts as unstable. */
  board_stale_hours: positiveInt,
  /** Upper size of an imported file, bytes. */
  import_max_bytes: positiveInt,
  /** How many discovered boards the registry page lists before "show more" (optional, 10 when absent; the list can hold hundreds). Absent on purpose: a default would be written into the file by every save. */
  candidates_page_size: positiveInt.optional(),
  /** Career page of a board; `{token}` is replaced by the board token (Lever EU boards use `lever_eu`). */
  board_page_urls: z.strictObject({
    greenhouse: boardPageUrl,
    lever: boardPageUrl,
    lever_eu: boardPageUrl,
    ashby: boardPageUrl,
    personio: boardPageUrl,
    smartrecruiters: boardPageUrl,
  }),
});

export type RegistrySettings = z.infer<typeof registrySettingsSchema>;

export const REGISTRY_DEFAULTS: RegistrySettings = {
  window_days: 7,
  board_failing_after: 2,
  board_stale_hours: 48,
  import_max_bytes: 524288,
  board_page_urls: BOARD_PAGE_URL_DEFAULTS,
};

export const channelsSchema = z
  .strictObject({
    paid_total_monthly_budget_usd: nonNegativeNumber,
    circuit_breaker: z.strictObject({
      /** Consecutive failures before a channel is marked unavailable. */
      failures: positiveInt,
      cooldown_hours: nonNegativeNumber,
    }),
    collect: z
      .strictObject({
        /** Channels (and the LinkedIn cascade as one unit) collected in parallel within a cycle. */
        concurrency: positiveInt.default(3),
        /** Serve the queries waiting longest on the unit's starting channel first. */
        query_rotation: z.boolean().default(true),
      })
      .default({ concurrency: 3, query_rotation: true }),
    http: httpSettings.default({ timeout_ms: 30000, max_retries: 3, backoff_base_ms: 1000, backoff_max_ms: 30000 }),
    /** The channel test; a file without the block gets the defaults of the shipped YAML. */
    test_channel: testChannel.default(TEST_CHANNEL_DEFAULTS),
    linkedin: z.strictObject({
      /** Main search uses the first available channel in this order. */
      cascade: z
        .array(linkedinChannelId)
        .min(1)
        .refine(
          (ids) => new Set(ids).size === ids.length,
          "must not contain duplicates",
        ),
      brightdata: z
        .strictObject({
          ...baseShape,
          free_records_per_month: nonNegativeInt,
          /** Bright Data dataset "LinkedIn job listings - discover by keyword". */
          dataset_id: nonEmptyString,
          /** USD per 1000 records beyond the free allowance (0 = treat as free). */
          cost_per_1k_usd: nonNegativeNumber,
          /** Wait between progress checks of an asynchronous snapshot. */
          poll_interval_ms: positiveInt,
          /** Give up on a snapshot after this long; covers the whole trigger -> build -> download span. */
          timeout_ms: positiveInt,
          /** ISO 3166-1 alpha-2 country sent with every located query (all `search.yaml: locations`); empty or missing = the market's. */
          country: z.string().regex(/^(?:[A-Z]{2})?$/, "must be an ISO 3166-1 alpha-2 code, upper case, or empty").optional(),
          /** `location` sent for the remote query per remote scope kind; a missing key follows the market. */
          remote_locations: remoteLocations,
        })
        .refine((b) => b.poll_interval_ms <= b.timeout_ms, {
          message: "poll_interval_ms must be <= timeout_ms",
          path: ["poll_interval_ms"],
        }),
      apify: z.strictObject({
        ...baseShape,
        /** Apify actor, `username/actor-name` or its 17-character id. Empty = not configured (the cascade skips the channel). */
        actor_id: z.string().trim().regex(/^(?:[A-Za-z0-9][A-Za-z0-9._-]*[/~][A-Za-z0-9][A-Za-z0-9._-]*|[A-Za-z0-9]{17})?$/, "must be username/actor-name, an actor id, or empty"),
        /** Apify API host. */
        api_base_url: httpBaseUrl,
        /** USD per 1000 dataset items (the actor's price on your Apify plan); used for budget accounting. */
        price_per_1k_usd: nonNegativeNumber,
        /** USD charged once per actor run (the actor-start event at the configured memory); 0 = none. */
        run_start_usd: nonNegativeNumber,
        /** Memory of one run in MB (a power of two, at least 128); the actor-start fee scales with it. */
        memory_mb: positiveInt,
        /** Run timeout in seconds. A synchronous run is limited to 300 s by Apify. */
        timeout_secs: positiveInt.max(300),
        /** Country name appended to a city for located queries (`Berlin, Germany`); empty or missing = the market's home country. */
        country_name: z.string().trim().optional(),
        /** `location` sent for the remote query per remote scope kind; a missing key follows the market. */
        remote_locations: remoteLocations,
        /** The actor's own wire format of the look-back filter, by window: day (<= 24 h), week, month, any (longer). Empty string = leave the input key out. */
        date_posted: z.strictObject({
          day: z.string(),
          week: z.string(),
          month: z.string(),
          any: z.string(),
        }),
        /**
         * The actor input of one query. String values may use {keywords}, {location}, {date_posted} and {limit}
         * (a value that is exactly "{limit}" becomes a number); keys whose value ends up empty are left out.
         */
        input_template: z.record(z.string(), z.unknown()),
        /** Keys merged over `input_template` for remote queries. */
        remote_input: z.record(z.string(), z.unknown()),
      }),
      session: sessionSettingsSchema,
      guest: channel,
    }),
    // Only for a file without a `jobspy` block, which is an existing configuration: its behaviour stays as it was. The shipped
    // config/sources.yaml (new installs) switches linkedin_fetch_description off.
    jobspy: jobspySettings.default({
      url: "http://127.0.0.1:8000",
      timeout_ms: 180000,
      linkedin_fetch_description: true,
      remote_location: { worldwide: "" },
      proxies: [],
    }),
    sources: z.strictObject({
      arbeitsagentur: arbeitsagenturSettingsSchema,
      indeed: channel,
      stepstone: stepstoneSettingsSchema,
      xing: xingSettingsSchema,
      arbeitnow: arbeitnowSettingsSchema,
      jsearch: jsearchChannel,
      greenhouse: greenhouseChannel,
      lever: leverChannel,
      ashby: ashbyChannel,
      personio: personioChannel,
      smartrecruiters: smartrecruitersChannel,
      brave: braveChannel,
      tavily: tavilyChannel,
      gmail: gmailSettingsSchema,
      jobspy_google: channel,
    }),
    /** ATS company boards collected by the greenhouse / lever / ashby / personio / smartrecruiters channels (was sources.yaml (ats_boards)). */
    ats_boards: atsBoardsSchema,
    /** Settings of the source registry page; the defaults only matter for the legacy compatibility mode. */
    registry: registrySettingsSchema.default(REGISTRY_DEFAULTS),
  })
  .superRefine((cfg, ctx) => {
    const cap = cfg.paid_total_monthly_budget_usd;
    const budgets: Array<[Array<string>, number]> = [
      [["linkedin", "brightdata"], cfg.linkedin.brightdata.monthly_budget_usd],
      [["linkedin", "apify"], cfg.linkedin.apify.monthly_budget_usd],
      [["linkedin", "session"], cfg.linkedin.session.monthly_budget_usd],
      [["linkedin", "guest"], cfg.linkedin.guest.monthly_budget_usd],
      ...Object.entries(cfg.sources).map(([id, c]): [Array<string>, number] => [
        ["sources", id],
        c.monthly_budget_usd,
      ]),
    ];
    for (const [where, budget] of budgets) {
      if (budget > cap) {
        ctx.addIssue({
          code: "custom",
          message: "must not exceed paid_total_monthly_budget_usd",
          path: [...where, "monthly_budget_usd"],
        });
      }
    }
  });

export type ChannelsConfig = z.infer<typeof channelsSchema>;
export type ChannelSettings = z.infer<typeof channel>;
export type JobspySettings = z.infer<typeof jobspySettings>;
