/**
 * Reason codes of the hard filter. `scores.filter_reasons` holds one string per
 * reason: `code` or `code:detail` (the detail is a value for the message, e.g. the matched keyword).
 * No imports: the UI uses this too.
 */

/** Why a job is filtered out (`filtered_out`). */
export const EXCLUDE_REASON_CODES = [
  "location_not_allowed",
  "remote_not_wanted",
  "remote_out_of_scope",
  "workplace_not_wanted",
  "student_role",
  "contract_excluded",
  "contract_not_allowed",
  "salary_below_floor",
  "blacklist_company",
  "blacklist_keyword",
  "seniority_mismatch",
  "deal_breaker",
  "override_exclude",
] as const;
export type ExcludeReasonCode = (typeof EXCLUDE_REASON_CODES)[number];

/** Notes on a job that was kept: something the posting does not say (C3), so the filter did not decide on it. */
export const NOTE_CODES = ["remote_scope_unknown", "remote_scope_description", "location_unknown", "location_country_level", "watched_company_location", "override_keep"] as const;
export type NoteCode = (typeof NOTE_CODES)[number];

export type FilterReasonCode = ExcludeReasonCode | NoteCode;

const KNOWN_CODES: readonly string[] = [...EXCLUDE_REASON_CODES, ...NOTE_CODES];

export interface ParsedFilterReason {
  /** Null for a text that is not one of the codes (older rows, seed data): show it verbatim. */
  code: FilterReasonCode | null;
  detail: string | null;
  raw: string;
}

export function encodeReason(code: FilterReasonCode, detail?: string | number | null): string {
  if (detail === undefined || detail === null || detail === "") return code;
  return `${code}:${detail}`;
}

export function parseFilterReason(raw: string): ParsedFilterReason {
  const colon = raw.indexOf(":");
  const head = colon === -1 ? raw : raw.slice(0, colon);
  if (!KNOWN_CODES.includes(head)) return { code: null, detail: null, raw };
  const detail = colon === -1 ? null : raw.slice(colon + 1);
  return { code: head as FilterReasonCode, detail: detail === "" ? null : detail, raw };
}

const NOTE_SET: ReadonlySet<string> = new Set(NOTE_CODES);

/** Reasons that excluded the job (the notes are for jobs that were kept). */
export function isNoteReason(raw: string): boolean {
  const { code } = parseFilterReason(raw);
  return code !== null && NOTE_SET.has(code);
}

/**
 * The reasons in the order they are shown: the user's own decision first, then the user's deal-breakers (the rules they
 * wrote themselves), then the rest in the order the filter found them.
 */
export function orderedReasons(reasons: readonly string[]): string[] {
  const rank = (raw: string): number => {
    const { code } = parseFilterReason(raw);
    return code === "override_keep" || code === "override_exclude" ? 0 : code === "deal_breaker" ? 1 : 2;
  };
  return reasons
    .map((raw, index) => ({ raw, index }))
    .sort((a, b) => rank(a.raw) - rank(b.raw) || a.index - b.index)
    .map((entry) => entry.raw);
}

/** The ids of the deal-breakers among the reasons (`deal_breaker:<id>`). */
export function dealBreakerIds(reasons: readonly string[]): string[] {
  return reasons.flatMap((raw) => {
    const { code, detail } = parseFilterReason(raw);
    return code === "deal_breaker" && detail !== null ? [detail] : [];
  });
}
