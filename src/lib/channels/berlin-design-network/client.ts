import type { BerlinDesignNetworkSettings } from "@/lib/config";

import type { BoardLink } from "../discovery/harvest";
import { ChannelError } from "../errors";
import { readTextUpTo } from "../http";
import type { ChannelContext } from "../types";
import { extractJsonAfter } from "../web/embedded";
import { jobSchema, nextDataSchema } from "./schema";

/** Path of the job list below `base_url`. */
export const JOBS_PATH = "jobs";

const NEXT_DATA_ANCHOR = '<script id="__NEXT_DATA__"';
const MAX_REDIRECTS = 3;
/** The job list page is a few hundred KB; a body beyond this is not the page. */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

type ClientSettings = Pick<BerlinDesignNetworkSettings, "base_url" | "user_agent">;

export const jobsUrl = (settings: Pick<BerlinDesignNetworkSettings, "base_url">): string => `${settings.base_url.replace(/\/+$/, "")}/${JOBS_PATH}`;

/**
 * The page as text: one GET. A redirect is followed only within the site's own origin (the address comes from the settings, but
 * a redirect is data); 403 arrives as `blocked`, 429 / 5xx were retried by `ctx.http`.
 */
export async function fetchJobsPage(ctx: ChannelContext, settings: ClientSettings): Promise<string> {
  let url = jobsUrl(settings);
  const origin = new URL(url).origin;
  for (let hop = 0; ; hop += 1) {
    const response = await ctx.http.request(url, { headers: { "User-Agent": settings.user_agent, Accept: "text/html" }, redirect: "manual" });
    if (response.status < 300 || response.status >= 400) {
      const page = response.textUpTo ? await response.textUpTo(MAX_PAGE_BYTES) : await readTextUpTo(response, MAX_PAGE_BYTES);
      if (page.truncated) throw new ChannelError("parse", "the job list page is larger than expected");
      return page.text;
    }
    const location = response.headers.get("location");
    await response.cancel?.();
    let next: URL | null = null;
    try {
      next = location ? new URL(location, url) : null;
    } catch {
      next = null;
    }
    if (next === null || next.origin !== origin) throw new ChannelError("blocked", "the job list redirects away from the site", { status: response.status });
    if (hop >= MAX_REDIRECTS) throw new ChannelError("network", "the job list redirects too often");
    url = next.href;
  }
}

export interface JobLinks {
  /** Entries of the list, valid or not. */
  total: number;
  /** One per entry with an apply link and nothing else of the entry. */
  links: BoardLink[];
  /** Entries of an unexpected shape, dropped. */
  invalid: number;
}

/**
 * The apply links and company names of the page's job list. A page that has no list (no `__NEXT_DATA__`, not JSON, a different
 * shape) is a `parse` error and gives nothing; a single entry of the wrong shape is dropped and counted.
 */
export function linksFromPage(html: string): JobLinks {
  const data = extractJsonAfter(html, NEXT_DATA_ANCHOR, "job list");
  if (data === null) throw new ChannelError("parse", "the page has no embedded job list (__NEXT_DATA__)");
  const parsed = nextDataSchema.safeParse(data);
  if (!parsed.success) throw new ChannelError("parse", "the embedded job list does not have the expected shape");
  const links: BoardLink[] = [];
  let invalid = 0;
  for (const entry of parsed.data.props.pageProps.page.pageData.jobs) {
    const job = jobSchema.safeParse(entry);
    if (!job.success) {
      invalid += 1;
      continue;
    }
    links.push({ url: job.data.attributes.link, label: job.data.attributes.at_company_text?.trim() || null });
  }
  return { total: parsed.data.props.pageProps.page.pageData.jobs.length, links, invalid };
}
