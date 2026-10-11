/**
 * Form drafts for the profile page. A draft is what the browser holds and sends: plain
 * strings, booleans and lists. It is untrusted input, so it is validated with zod (C6), converted
 * to the config shape and then validated again with the real config schema (the single source of
 * truth for what a valid profile is, C8).
 *
 * Pure and free of server-only imports: the client form and the server action share it.
 */
import { z } from "zod";

import type { MeConfig } from "@/lib/config/schemas/me";
import type { PreferencesConfig } from "@/lib/config/schemas/preferences";
import { parseRemoteScopeKey, remoteScopeKey } from "@/lib/market/remote-scope";

// Option lists mirror the zod enums in the config schemas; tests/profile/draft.test.ts compares them.
export const LANGUAGE_LEVEL_OPTIONS = ["A1", "A2", "B1", "B2", "C1", "C2", "native"] as const satisfies readonly MeLevel[];
export const WORKPLACE_OPTIONS = ["onsite", "hybrid", "remote"] as const satisfies readonly PreferencesConfig["workplace"][number][];
/** The kinds of remote scope; `region` comes with a list of regions / countries. */
export const REMOTE_SCOPE_KINDS = ["none", "home_country", "worldwide", "region"] as const;
export type RemoteScopeKind = (typeof REMOTE_SCOPE_KINDS)[number];
export const SENIORITY_OPTIONS = ["all", "entry", "mid", "senior", "lead"] as const satisfies readonly PreferencesConfig["seniority"][];
export const CONTRACT_OPTIONS = ["permanent", "fixed_term", "freelance", "temp_agency"] as const satisfies readonly PreferencesConfig["contracts"]["allow"][number][];
export const CONTRACT_MODES = ["none", "allow", "exclude"] as const;

type MeLevel = MeConfig["languages"][number][string];
export type ContractMode = (typeof CONTRACT_MODES)[number];

export interface LanguageDraft {
  code: string;
  level: string;
}
export interface SkillDraft {
  name: string;
  years: string;
}

export interface MeDraft {
  languages: LanguageDraft[];
  skills: SkillDraft[];
  years_experience: string;
  city: string;
  needs_visa_sponsorship: boolean;
  summary: string;
}

/** preferences.yaml `market` as the form holds it; an empty text = take the pack's value. */
export interface MarketDraft {
  pack: string;
  country: string;
  currency: string;
  home_language: string;
}

export interface PreferencesDraft {
  market: MarketDraft;
  target_titles: string[];
  locations: string[];
  workplace: string[];
  /** `remoteScopeKey`: `none`, `home_country`, `worldwide` or `region:eu,CH`. */
  remote_scope: string;
  seniority: string;
  salary_floor_year: string;
  /** Contract kind -> allow / exclude / none. */
  contracts: Record<string, string>;
  exclude_student_roles: boolean;
  exclude_companies: string[];
  exclude_keywords: string[];
}

export const meDraftSchema = z.strictObject({
  languages: z.array(z.strictObject({ code: z.string(), level: z.string() })),
  skills: z.array(z.strictObject({ name: z.string(), years: z.string() })),
  years_experience: z.string(),
  city: z.string(),
  needs_visa_sponsorship: z.boolean(),
  summary: z.string(),
});

export const preferencesDraftSchema = z.strictObject({
  market: z.strictObject({ pack: z.string(), country: z.string(), currency: z.string(), home_language: z.string() }),
  target_titles: z.array(z.string()),
  locations: z.array(z.string()),
  workplace: z.array(z.string()),
  remote_scope: z.string(),
  seniority: z.string(),
  salary_floor_year: z.string(),
  contracts: z.record(z.string(), z.string()),
  exclude_student_roles: z.boolean(),
  exclude_companies: z.array(z.string()),
  exclude_keywords: z.array(z.string()),
});

const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Text field -> number for the config schema. Empty means "not given": `null` when the field is
 * nullable, otherwise `undefined` (reported as "required"). Anything that is not a plain decimal
 * becomes NaN (reported as "not a number").
 */
function toNumber(text: string, nullable: boolean): number | null | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return nullable ? null : undefined;
  return DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
}

function numberToText(value: number | null): string {
  return value === null ? "" : String(value);
}

// ---------------------------------------------------------------- config <-> draft

export function meConfigToDraft(me: MeConfig): MeDraft {
  return {
    languages: me.languages.map((entry) => {
      const [code, level] = Object.entries(entry)[0] ?? ["", "B1"];
      return { code, level };
    }),
    skills: me.skills.map((skill) => ({ name: skill.name, years: numberToText(skill.years) })),
    years_experience: numberToText(me.years_experience),
    city: me.city,
    needs_visa_sponsorship: me.needs_visa_sponsorship,
    summary: me.summary,
  };
}

/** The unvalidated config candidate for a me draft (feed it to `meSchema`). */
export function meDraftToCandidate(draft: MeDraft): unknown {
  return {
    languages: draft.languages.map((row) => ({ [row.code.trim().toLowerCase()]: row.level })),
    skills: draft.skills.map((row) => ({ name: row.name, years: toNumber(row.years, true) })),
    years_experience: toNumber(draft.years_experience, true),
    city: draft.city,
    needs_visa_sponsorship: draft.needs_visa_sponsorship,
    summary: draft.summary,
  };
}

export function preferencesConfigToDraft(prefs: PreferencesConfig): PreferencesDraft {
  const contracts: Record<string, string> = {};
  for (const kind of CONTRACT_OPTIONS) {
    contracts[kind] = prefs.contracts.allow.includes(kind) ? "allow" : prefs.contracts.exclude.includes(kind) ? "exclude" : "none";
  }
  return {
    market: { pack: prefs.market.pack, country: prefs.market.country ?? "", currency: prefs.market.currency ?? "", home_language: prefs.market.home_language ?? "" },
    target_titles: [...prefs.target_titles],
    locations: [...prefs.locations],
    workplace: [...prefs.workplace],
    remote_scope: remoteScopeKey(prefs.remote_scope),
    seniority: prefs.seniority,
    salary_floor_year: String(prefs.salary_floor_year),
    contracts,
    exclude_student_roles: prefs.exclude_student_roles,
    exclude_companies: [...prefs.exclude_companies],
    exclude_keywords: [...prefs.exclude_keywords],
  };
}

/** The market block of a draft: empty values are left out (the pack's value applies). */
function marketCandidate(draft: MarketDraft): Record<string, string> {
  const out: Record<string, string> = { pack: draft.pack.trim() };
  if (draft.country.trim() !== "") out.country = draft.country.trim().toUpperCase();
  if (draft.currency.trim() !== "") out.currency = draft.currency.trim().toUpperCase();
  if (draft.home_language.trim() !== "") out.home_language = draft.home_language.trim().toLowerCase();
  return out;
}

export function preferencesDraftToCandidate(draft: PreferencesDraft): unknown {
  return {
    market: marketCandidate(draft.market),
    target_titles: draft.target_titles,
    locations: draft.locations,
    workplace: WORKPLACE_OPTIONS.filter((option) => draft.workplace.includes(option)),
    remote_scope: parseRemoteScopeKey(draft.remote_scope) ?? draft.remote_scope,
    seniority: draft.seniority,
    salary_floor_year: toNumber(draft.salary_floor_year, false),
    contracts: {
      allow: CONTRACT_OPTIONS.filter((kind) => draft.contracts[kind] === "allow"),
      exclude: CONTRACT_OPTIONS.filter((kind) => draft.contracts[kind] === "exclude"),
    },
    exclude_student_roles: draft.exclude_student_roles,
    exclude_companies: draft.exclude_companies,
    exclude_keywords: draft.exclude_keywords,
  };
}

// ---------------------------------------------------------------- errors

export type FieldErrorKey =
  | "required"
  | "number"
  | "integer"
  | "min"
  | "atLeastOne"
  | "duplicates"
  | "tooLong"
  | "languageCode"
  | "invalidChoice"
  | "contractConflict"
  | "invalid";

export interface FieldError {
  /** Field path in draft space, e.g. `salary_floor_year`, `languages.0`, `skills.1.years`. */
  path: string;
  key: FieldErrorKey;
  params?: Record<string, string | number>;
}

type Issue = z.core.$ZodIssue;

/** Lists of plain strings are edited as one control: item errors belong to the list itself. */
const STRING_LISTS = new Set(["target_titles", "locations", "workplace", "exclude_companies", "exclude_keywords"]);

function draftPath(path: ReadonlyArray<PropertyKey>): string {
  const [head, index, field] = path;
  if (typeof head !== "string") return "";
  if (STRING_LISTS.has(head)) return head;
  if (head === "contracts") return "contracts";
  // Rows of `languages` carry one error line; the record key/level distinction is in the message key.
  if (head === "languages") return typeof index === "number" ? `languages.${index}` : "languages";
  if (head === "skills" && typeof index === "number" && typeof field === "string") return `skills.${index}.${field}`;
  return path.map(String).join(".");
}

export function issueKey(issue: Issue): Pick<FieldError, "key" | "params"> {
  switch (issue.code) {
    case "invalid_type":
      if (issue.expected === "int") return { key: "integer" };
      if (issue.expected === "number") return { key: /received undefined/.test(issue.message) ? "required" : "number" };
      return { key: "required" };
    case "too_small":
      if (issue.origin === "string") return { key: "required" };
      if (issue.origin === "array") return { key: "atLeastOne" };
      return { key: "min", params: { min: Number(issue.minimum) } };
    case "too_big":
      return { key: "tooLong", params: { max: Number(issue.maximum) } };
    case "invalid_value":
    case "invalid_union":
      return { key: "invalidChoice" };
    case "invalid_key":
      return { key: "languageCode" };
    case "custom":
      if (issue.message === "must not contain duplicates") return { key: "duplicates" };
      if (issue.message === "needs at least one workplace type") return { key: "atLeastOne" };
      if (issue.message.startsWith("a contract type cannot be both")) return { key: "contractConflict" };
      if (issue.message.startsWith("each entry must have exactly one")) return { key: "languageCode" };
      return { key: "invalid", params: { message: issue.message } };
    default:
      return { key: "invalid", params: { message: issue.message } };
  }
}

/** Zod issues from the config schema -> field errors addressed in draft space (one per field). */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  const seen = new Set<string>();
  const out: FieldError[] = [];
  for (const issue of error.issues) {
    const path = draftPath(issue.path);
    const mapped = issueKey(issue);
    const id = `${path}|${mapped.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ path, ...mapped });
  }
  return out;
}
