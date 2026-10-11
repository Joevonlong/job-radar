import type { CompanyEntry } from "@/lib/config";

/**
 * Which URLs are an official career-board URL of each ATS, and which board they point at.
 * Discovery accepts nothing else: a search result on any other host is ignored, however much its
 * path looks like a board.
 */

export type DiscoverableAts = CompanyEntry["ats"];

export interface BoardRef {
  ats: DiscoverableAts;
  /** The sources.yaml (ats_boards) `token` (case as the ATS spells it; SmartRecruiters ids are case-sensitive). */
  token: string;
  /** Lever only: the board lives on the EU host. */
  region: "eu" | null;
}

/** Path words that are never a board slug. */
const RESERVED = new Set(["embed", "jobs", "job", "api", "www", "careers", "apply", "widget", "v0", "v1", "static", "assets"]);
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function acceptable(token: string | undefined): token is string {
  return token !== undefined && TOKEN.test(token) && !RESERVED.has(token.toLowerCase());
}

/** Exact hosts whose first path segment is the board token. */
const PATH_HOSTS: ReadonlyArray<{ host: string; ats: DiscoverableAts; region: "eu" | null }> = [
  { host: "boards.greenhouse.io", ats: "greenhouse", region: null },
  { host: "job-boards.greenhouse.io", ats: "greenhouse", region: null },
  { host: "job-boards.eu.greenhouse.io", ats: "greenhouse", region: null },
  { host: "jobs.lever.co", ats: "lever", region: null },
  { host: "jobs.eu.lever.co", ats: "lever", region: "eu" },
  { host: "jobs.ashbyhq.com", ats: "ashby", region: null },
  { host: "jobs.smartrecruiters.com", ats: "smartrecruiters", region: null },
  { host: "careers.smartrecruiters.com", ats: "smartrecruiters", region: null },
];

const PERSONIO_SUFFIX = ".jobs.personio.de";

/** The board an official ATS URL points at, or null for anything else. */
export function boardFromUrl(value: string): BoardRef | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();

  if (host.endsWith(PERSONIO_SUFFIX)) {
    const token = host.slice(0, -PERSONIO_SUFFIX.length);
    // one label only: `a.b.jobs.personio.de` is not a company career site
    return acceptable(token) && !token.includes(".") ? { ats: "personio", token, region: null } : null;
  }

  const entry = PATH_HOSTS.find((h) => h.host === host);
  if (!entry) return null;
  const segments = url.pathname.split("/").filter((s) => s !== "");
  let first = segments[0];
  // the one-click UI nests the company: /oneclick-ui/company/{id}/...
  if (entry.ats === "smartrecruiters" && first === "oneclick-ui" && segments[1] === "company") first = segments[2];
  let token: string | undefined;
  try {
    token = first === undefined ? undefined : decodeURIComponent(first);
  } catch {
    return null;
  }
  return acceptable(token) ? { ats: entry.ats, token, region: entry.region } : null;
}

/** `site:` operands whose results can be boards of `ats` (the hosts of PATH_HOSTS plus the Personio sub-domains). */
export function searchHostsFor(ats: DiscoverableAts): string[] {
  if (ats === "personio") return ["jobs.personio.de"];
  return PATH_HOSTS.filter((h) => h.ats === ats).map((h) => h.host);
}

export const DISCOVERABLE_ATS: readonly DiscoverableAts[] = ["greenhouse", "lever", "ashby", "personio", "smartrecruiters"];

/** Key under which a board counts as "already known" (sources.yaml (ats_boards), earlier candidates): tokens differ in case between sources. */
export function boardKey(ats: string, token: string): string {
  return `${ats}:${token.toLowerCase()}`;
}
