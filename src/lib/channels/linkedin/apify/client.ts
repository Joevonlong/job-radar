import { BudgetExceededError, ChannelError } from "../../errors";
import type { ChannelContext } from "../../types";
import { MAX_RESPONSE_CHARS } from "./contract";

/** HTTP status Apify answers when the account has no credit / the usage limit is reached. */
const PAYMENT_REQUIRED = 402;
/** Added to the actor's run timeout so the HTTP request outlives the run and the 408 / items arrive. */
const REQUEST_SLACK_MS = 30_000;

export interface RunActorOptions {
  ctx: ChannelContext;
  token: string;
  /** Full `run-sync-get-dataset-items` URL (see `runSyncUrl`). */
  url: string;
  input: Record<string, unknown>;
  /** The actor's run timeout; the request waits this long plus a little. */
  timeoutSecs: number;
}

/**
 * Run an actor synchronously and return its dataset items. The token is only ever set here, as a Bearer header,
 * and never logged. The request is sent once (no retries): repeating a run would bill it twice. Failures are
 * classified by `ctx.http` (401 auth, 403 blocked, 408/5xx network, 429 rate limited, other 4xx non-retryable);
 * 402 (no credit left at Apify) is a budget failure so the cascade moves on.
 */
export async function runActorSync(options: RunActorOptions): Promise<unknown[]> {
  const { ctx } = options;
  const response = await ctx.http.request(options.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(options.input),
    maxRetries: 0,
    timeoutMs: options.timeoutSecs * 1000 + REQUEST_SLACK_MS,
    allowStatus: [PAYMENT_REQUIRED],
    // the token must not follow a redirect to another host
    redirect: "error",
  });
  if (response.status === PAYMENT_REQUIRED) {
    throw new BudgetExceededError("channel", "Apify answered 402: the Apify account has no credit or usage left");
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_CHARS) throw new ChannelError("parse", "Apify dataset exceeds the size limit");
  let body: unknown;
  try {
    body = text.trim() === "" ? [] : JSON.parse(text);
  } catch (error) {
    throw new ChannelError("parse", "Apify response is not valid JSON", { cause: error });
  }
  if (!Array.isArray(body)) throw new ChannelError("parse", "Apify response is not a JSON array of dataset items");
  return body;
}
