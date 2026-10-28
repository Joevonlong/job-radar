import { createHash } from "node:crypto";

import type { JobForSalaryLookup } from "@/lib/db/repos/salary-lookups";

const keyPart = (text: string | null): string =>
  (text ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[|\s]+/g, " ")
    .trim() || "-";

/** The longest lookup key (the request payload accepts up to 600 characters). */
export const LOOKUP_KEY_MAX = 400;

/**
 * The cache key of a lookup: normalised company, role family, title, seniority, country and city. Two postings of the same
 * role at the same company and place share one lookup; another city or title is a new one. A key longer than
 * `LOOKUP_KEY_MAX` keeps its start and gets a hash of the whole key, so long names stay distinct and within the request payload's limit.
 */
export function salaryLookupKey(job: Pick<JobForSalaryLookup, "companyNorm" | "titleNorm" | "seniority" | "location">, family: string | null): string {
  const key = [keyPart(job.companyNorm), family ?? "-", keyPart(job.titleNorm), keyPart(job.seniority), keyPart(job.location?.countryCode ?? null), keyPart(job.location?.city ?? null)].join("|");
  if (key.length <= LOOKUP_KEY_MAX) return key;
  return `${key.slice(0, LOOKUP_KEY_MAX - 17)}#${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

const COMPANY_PART = 0;
const TITLE_PART = 2;

/**
 * A stored lookup key with its company or title part changed from what `from` gives to what `to` gives (a company or a
 * title whose key was recomputed, a company folded into another), so the lookup stays the cached answer for its job.
 * Null when the key does not hold `from` there, or when it is a shortened key (its hash covers the whole key and cannot be
 * worked out again): that lookup is simply not found by the new key.
 */
export function rekeySalaryLookupKey(key: string, part: "company" | "title", from: string, to: string): string | null {
  if (key.length === LOOKUP_KEY_MAX && key[LOOKUP_KEY_MAX - 17] === "#") return null;
  const parts = key.split("|");
  const index = part === "company" ? COMPANY_PART : TITLE_PART;
  if (parts.length !== 6 || parts[index] !== keyPart(from)) return null;
  parts[index] = keyPart(to);
  const next = parts.join("|");
  return next.length <= LOOKUP_KEY_MAX ? next : null;
}
