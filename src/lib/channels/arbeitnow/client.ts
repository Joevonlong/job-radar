import type { ArbeitnowSettings } from "@/lib/config";

import { issuePaths } from "../ats/envelope";
import { ChannelError } from "../errors";
import type { ChannelContext } from "../types";
import { pageSchema, type ArbeitnowPage } from "./schema";

/** Path of the board API below `base_url`. */
export const API_PATH = "api/job-board-api";

/** "Gone": the API was taken down. Treated like a 403 (blocked), so the circuit opens and /sources shows why. */
const WITHDRAWN_STATUS = 410;

type ClientSettings = Pick<ArbeitnowSettings, "base_url" | "user_agent">;

/** URL of page `page` (1-based). The page parameter is always sent, also for page 1. */
export function pageUrl(settings: Pick<ArbeitnowSettings, "base_url">, page: number): string {
  return `${settings.base_url.replace(/\/+$/, "")}/${API_PATH}?page=${page}`;
}

/**
 * One page of the board. 429 / 5xx are retried by `ctx.http` (Retry-After honoured); 403 arrives as `blocked`, 410 is turned into
 * `blocked` here (the generic mapping calls it `unknown`). The response headers are not read: the `x-ratelimit-*` ones are
 * cached with the page and say nothing about our own usage.
 */
export async function fetchPage(ctx: ChannelContext, settings: ClientSettings, page: number): Promise<ArbeitnowPage> {
  const response = await ctx.http.request(pageUrl(settings, page), {
    headers: { "User-Agent": settings.user_agent, Accept: "application/json" },
    allowStatus: [WITHDRAWN_STATUS],
  });
  if (response.status === WITHDRAWN_STATUS) {
    throw new ChannelError("blocked", `API withdrawn (HTTP ${WITHDRAWN_STATUS})`, { status: WITHDRAWN_STATUS, tripsCircuit: true });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ChannelError("parse", `page ${page} is not valid JSON`, { cause: error });
  }
  const parsed = pageSchema.safeParse(body);
  if (!parsed.success) throw new ChannelError("parse", `page ${page} does not match the expected shape (${issuePaths(parsed.error)})`);
  return parsed.data;
}
