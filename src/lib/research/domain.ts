/**
 * A company's website domain: what a link or a typed address reduces to, and what the company's own postings suggest. An
 * inferred domain comes from third-party posting data, so it is only ever shown for the user to confirm: it never enters a
 * prompt or a fetch list (`confirmedWebsiteDomain`).
 */
import { isCompanyWebsiteCandidate, isPublicSuffixLike } from "@/lib/ai/web-tasks";
import type { ResearchConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { getCompanyRowForDomain, listCompanyPostingUrls, storeInferredCompanyDomain } from "@/lib/db/repos/company-research";

export interface CompanyWebsite {
  domain: string;
  source: "user" | "inferred";
}

/** How many of a company's posting links are looked at; more of the same employer say nothing new. */
const POSTINGS_READ = 50;

function hostOf(value: string): string | null {
  const text = value.trim();
  // `user@host` reads as a host in a URL, and is no way of naming a website
  if (text === "" || text.includes("@") || /\s/.test(text)) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
}

/**
 * The name a link or typed address belongs to (`careers.example.de` -> `example.de`, `jobs.company.co.uk` -> `company.co.uk`),
 * or null when it cannot be a company's own public website: an address, a local name, or a job board or applicant tracking
 * host (`nonCompanyHosts`).
 */
export function registrableDomainOf(value: string, nonCompanyHosts: readonly string[]): string | null {
  const host = hostOf(value);
  if (host === null) return null;
  const labels = host.split(".");
  // the shortest ending of the name that is one site rather than a public suffix
  for (let take = 2; take <= labels.length; take += 1) {
    const candidate = labels.slice(-take).join(".");
    if (isPublicSuffixLike(candidate)) continue;
    return isCompanyWebsiteCandidate(candidate, nonCompanyHosts) ? candidate : null;
  }
  return null;
}

/** The candidate most of the links point at, or null; a tie goes to the name that comes first, so the result does not depend on the order. */
export function mostCommonDomain(urls: readonly string[], nonCompanyHosts: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const url of urls) {
    const domain = registrableDomainOf(url, nonCompanyHosts);
    if (domain !== null) counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  const ranked = [...counts].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b));
  return ranked[0]?.[0] ?? null;
}

/** What a stored value shows: an inferred domain that the host list now refuses is no suggestion any more. */
export function shownWebsite(company: { websiteDomain: string | null; websiteDomainSource: string | null }, research: ResearchConfig): CompanyWebsite | null {
  const { websiteDomain: domain, websiteDomainSource: source } = company;
  if (domain === null) return null;
  if (source === "user") return { domain, source };
  return source === "inferred" && isCompanyWebsiteCandidate(domain, research.company.non_company_hosts) ? { domain, source } : null;
}

/** Suggest a website from the company's own posting links, for a company that has none yet. Stores what it finds as `inferred`; a user's domain is never replaced. */
export async function inferCompanyDomain(db: Db, companyId: number, research: ResearchConfig): Promise<CompanyWebsite | null> {
  const stored = await getCompanyRowForDomain(db, companyId);
  if (stored === null) return null;
  if (stored.websiteDomain !== null) return shownWebsite(stored, research);
  const domain = mostCommonDomain(await listCompanyPostingUrls(db, companyId, POSTINGS_READ), research.company.non_company_hosts);
  if (domain === null) return null;
  await storeInferredCompanyDomain(db, { companyId, domain });
  return shownWebsite((await getCompanyRowForDomain(db, companyId)) ?? { websiteDomain: null, websiteDomainSource: null }, research);
}
