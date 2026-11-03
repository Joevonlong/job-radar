import type { HandpickedSettings } from "@/lib/config";

import { issuePaths } from "../ats/envelope";
import { ChannelError } from "../errors";
import type { ChannelContext } from "../types";
import { detailSchema, ID_PATTERN, indexSchema, type HandpickedDetail } from "./schema";

/** Paths below `base_url`. */
export const INDEX_PATH = "jobs/search-index.json";
export const DETAIL_PATH = "jobs/d";

/** "Not found" / "gone" on the index: the file was taken down. Treated like a 403 (blocked), so the circuit opens and /sources shows why. */
const WITHDRAWN = [404, 410] as const;

type ClientSettings = Pick<HandpickedSettings, "base_url" | "user_agent">;

const root = (settings: Pick<HandpickedSettings, "base_url">): string => settings.base_url.replace(/\/+$/, "");

export const indexUrl = (settings: Pick<HandpickedSettings, "base_url">): string => `${root(settings)}/${INDEX_PATH}`;

/** Detail URL of a posting; null for an id that is not hexadecimal (it never goes into a path). */
export function detailUrl(settings: Pick<HandpickedSettings, "base_url">, id: string): string | null {
  return ID_PATTERN.test(id) ? `${root(settings)}/${DETAIL_PATH}/${id}.json` : null;
}

/** The whole index (one request) as an untyped array; each entry is checked by the caller, so one bad entry costs only itself. */
export async function fetchIndex(ctx: ChannelContext, settings: ClientSettings): Promise<unknown[]> {
  const response = await ctx.http.request(indexUrl(settings), {
    headers: { "User-Agent": settings.user_agent, Accept: "application/json" },
    allowStatus: WITHDRAWN,
  });
  if (WITHDRAWN.some((status) => status === response.status)) {
    throw new ChannelError("blocked", `index withdrawn (HTTP ${response.status})`, { status: response.status, tripsCircuit: true });
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ChannelError("parse", "index is not valid JSON", { cause: error });
  }
  const parsed = indexSchema.safeParse(body);
  if (!parsed.success) throw new ChannelError("parse", "index is not an array of postings");
  return parsed.data;
}

/**
 * The detail record of one posting; null when the site no longer has it (404). Other failures throw: 429 / 5xx were retried by
 * `ctx.http`, a 403 arrives as `blocked`. A record of the wrong shape is a `parse` error that concerns this posting only.
 */
export async function fetchDetail(ctx: ChannelContext, settings: ClientSettings, id: string): Promise<{ detail: HandpickedDetail; raw: unknown } | null> {
  const url = detailUrl(settings, id);
  if (url === null) throw new ChannelError("parse", "posting id is not hexadecimal");
  const response = await ctx.http.request(url, { headers: { "User-Agent": settings.user_agent, Accept: "application/json" }, allowStatus: [404] });
  if (response.status === 404) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new ChannelError("parse", "posting detail is not valid JSON", { cause: error });
  }
  const parsed = detailSchema.safeParse(body);
  if (!parsed.success) throw new ChannelError("parse", `posting detail does not match the expected shape (${issuePaths(parsed.error)})`);
  return { detail: parsed.data, raw: body };
}
