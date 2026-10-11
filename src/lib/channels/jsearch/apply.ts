import { boardFromUrl } from "../discovery/boards";
import type { JsearchJob } from "./schema";

/** An apply link with what is known about where it leads. */
export interface ApplyLink {
  url: string;
  publisher: string | null;
  /** The link leads to the employer's own site or ATS board, not to a job board. */
  direct: boolean;
}

/** Query parameters that only tell the target site where the click came from. */
const TRACKING_PARAM = /^(utm_|gclid$|gad_|fbclid$)/i;

/** The link as an http(s) URL without tracking parameters, or null when it is not one. */
export function cleanUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAM.test(key)) url.searchParams.delete(key);
  return url.toString();
}

function hostOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const host = new URL(/^[a-z]+:\/\//i.test(value) ? value : `https://${value}`).hostname.toLowerCase();
    return host.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Does the link lead to the employer's website (or a sub-domain of it)? */
function onEmployerSite(url: string, employerWebsite: string | null | undefined): boolean {
  const site = hostOf(employerWebsite);
  const host = hostOf(url);
  return site !== null && host !== null && (host === site || host.endsWith(`.${site}`));
}

/**
 * Every apply link of a job, best first. Direct links come first: the API's own `is_direct` flag, a
 * link on the employer's website, or an official ATS board URL (Greenhouse, Lever, Ashby, Personio,
 * SmartRecruiters). The rest follow in the order of `publisherPreference` (substring match on the
 * publisher name, case-insensitive); publishers not in the list come last. Ties keep the API's order.
 */
export function rankApplyLinks(job: JsearchJob, publisherPreference: readonly string[]): ApplyLink[] {
  const raw: Array<{ url: string | null; publisher: string | null; flagged: boolean }> = [
    { url: cleanUrl(job.job_apply_link), publisher: job.job_publisher ?? null, flagged: job.job_apply_is_direct === true },
    ...(job.apply_options ?? []).map((option) => ({ url: cleanUrl(option.apply_link), publisher: option.publisher ?? null, flagged: option.is_direct === true })),
  ];
  const seen = new Set<string>();
  const links: ApplyLink[] = [];
  for (const entry of raw) {
    if (entry.url === null || seen.has(entry.url)) continue;
    seen.add(entry.url);
    links.push({
      url: entry.url,
      publisher: entry.publisher,
      direct: entry.flagged || onEmployerSite(entry.url, job.employer_website) || boardFromUrl(entry.url) !== null,
    });
  }
  const preference = publisherPreference.map((name) => name.toLowerCase());
  const rank = (link: ApplyLink): number => {
    if (link.direct) return -1;
    const publisher = link.publisher?.toLowerCase();
    const index = publisher === undefined ? -1 : preference.findIndex((name) => publisher.includes(name));
    return index === -1 ? preference.length : index;
  };
  // Array.prototype.sort is stable: equal ranks keep the API's order
  return links.sort((a, b) => rank(a) - rank(b));
}
