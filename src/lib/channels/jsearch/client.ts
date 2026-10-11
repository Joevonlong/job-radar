import type { JsearchSettings } from "@/lib/config";

import { ChannelError } from "../errors";
import type { ChannelContext, HttpResponse } from "../types";
import type { JsearchRequest } from "./query";
import { recordsOf, responseSchema } from "./schema";

/** Name of the environment variable holding the RapidAPI key. */
export const JSEARCH_API_KEY_ENV = "JSEARCH_API_KEY";
/** Most job ids one `/job-details` call takes (each id counts as a request). Fixed by the API. */
export const MAX_DETAIL_IDS = 20;

const ERROR_BODY_EXCERPT_CHARS = 1000;

type ClientSettings = Pick<JsearchSettings, "api_base_url" | "country" | "language" | "pages_per_query" | "rate_limit_retries">;

function endpoint(settings: ClientSettings, path: string): string {
  return `${settings.api_base_url.replace(/\/+$/, "")}/${path}`;
}

function headers(settings: ClientSettings, apiKey: string): Record<string, string> {
  return { "X-RapidAPI-Key": apiKey, "X-RapidAPI-Host": new URL(settings.api_base_url).host, Accept: "application/json" };
}

export function searchUrl(settings: ClientSettings, request: JsearchRequest): string {
  const params = new URLSearchParams({
    query: request.query,
    page: "1",
    num_pages: String(settings.pages_per_query),
    country: settings.country ?? "",
    date_posted: request.datePosted,
  });
  if (settings.language !== "") params.set("language", settings.language);
  if (request.remote) params.set("work_from_home", "true");
  return `${endpoint(settings, "search")}?${params.toString()}`;
}

export function detailsUrl(settings: ClientSettings, jobIds: readonly string[]): string {
  const params = new URLSearchParams({ job_id: jobIds.join(","), country: settings.country ?? "" });
  if (settings.language !== "") params.set("language", settings.language);
  return `${endpoint(settings, "job-details")}?${params.toString()}`;
}

/**
 * What a 429 means. RapidAPI answers it for a used-up plan quota ("exceeded the MONTHLY quota ...")
 * and for a rate limit per second / hour alike. `quota`: nothing works until the plan renews
 * (opens the circuit at once); `window`: an hourly / daily limit (waiting seconds does not help);
 * `burst`: too many requests in a short time (worth a short wait).
 */
export function classifyRateLimit(body: string, remainingHeader: string | null): "quota" | "window" | "burst" {
  if (remainingHeader !== null && remainingHeader.trim() === "0") return "quota";
  if (/quota|monthly|per month/i.test(body)) return "quota";
  if (/hour|daily|per day/i.test(body)) return "window";
  return "burst";
}

async function excerpt(response: HttpResponse): Promise<string> {
  try {
    return (await response.text()).slice(0, ERROR_BODY_EXCERPT_CHARS);
  } catch {
    return "";
  }
}

export interface JsearchAnswer {
  records: unknown[];
  /** Requests the plan has left, from the `X-RateLimit-Requests-Remaining` header, when sent. */
  remaining: number | null;
}

/**
 * One GET against JSearch. 5xx and network errors are retried by `ctx.http`; auth problems and 429s
 * are classified here because the response body tells the kinds of 429 apart (see `classifyRateLimit`).
 * Error messages never carry the response body or the key (C4).
 */
export async function getRecords(ctx: ChannelContext, settings: ClientSettings, apiKey: string, url: string): Promise<JsearchAnswer> {
  for (let attempt = 0; ; attempt += 1) {
    const response = await ctx.http.request(url, { headers: headers(settings, apiKey), allowStatus: [401, 403, 429], redirect: "error" });
    if (response.status === 401) {
      throw new ChannelError("auth_expired", `RapidAPI rejected ${JSEARCH_API_KEY_ENV} (HTTP 401)`, { status: 401 });
    }
    if (response.status === 403) {
      throw new ChannelError("auth_expired", `RapidAPI refused the request (HTTP 403): is ${JSEARCH_API_KEY_ENV} subscribed to JSearch?`, { status: 403 });
    }
    if (response.status === 429) {
      const kind = classifyRateLimit(await excerpt(response), response.headers.get("x-ratelimit-requests-remaining"));
      if (kind === "quota") {
        throw new ChannelError("rate_limited", "HTTP 429 from JSearch: the plan's monthly request quota is used up", { status: 429, retryable: false, tripsCircuit: true });
      }
      if (kind === "window") {
        throw new ChannelError("rate_limited", "HTTP 429 from JSearch: hourly or daily request limit reached", { status: 429, retryable: false });
      }
      if (attempt >= settings.rate_limit_retries) {
        throw new ChannelError("rate_limited", "HTTP 429 from JSearch: rate limited", { status: 429 });
      }
      ctx.logger.debug("jsearch rate limited, waiting before another try", { attempt: attempt + 1 });
      await ctx.throttle();
      continue;
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new ChannelError("parse", "JSearch response is not valid JSON", { cause: error });
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      const paths = parsed.error.issues.slice(0, 5).map((i) => i.path.join(".") || "(root)");
      throw new ChannelError("parse", `JSearch response does not match the expected shape (${paths.join(", ")})`);
    }
    const status = parsed.data.status;
    if (status !== null && status !== undefined && status.toUpperCase() !== "OK") {
      throw new ChannelError("unknown", `JSearch answered with status ${status.slice(0, 40)}`, { retryable: false });
    }
    const remainingHeader = response.headers.get("x-ratelimit-requests-remaining");
    const remaining = remainingHeader !== null && remainingHeader.trim() !== "" && Number.isFinite(Number(remainingHeader)) ? Number(remainingHeader) : null;
    return { records: recordsOf(parsed.data), remaining };
  }
}
