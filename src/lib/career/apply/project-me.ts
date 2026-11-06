/**
 * The me.yaml fields the career profile can fill: languages with a code and a CEFR level, skills with their years, years of
 * experience from the experience dates, and the summary. City and visa sponsorship have no source in the profile and keep
 * their values; nothing of the contact details or entry locations is projected. Pure: texts arrive through `scrub`.
 */
import { isDeepStrictEqual } from "node:util";

import type { MeConfig } from "@/lib/config/schemas/me";

import { primaryText, type CareerProfile } from "../schema/profile";
import { yearsOfExperience } from "./years";

export const ME_FIELDS = ["languages", "skills", "years_experience", "summary"] as const;
export type MeField = (typeof ME_FIELDS)[number];
export type MeSelection = Record<MeField, boolean>;

export interface MeFieldChange<F extends MeField = MeField> {
  field: F;
  current: MeConfig[F];
  proposed: MeConfig[F];
  changed: boolean;
  defaultSelected: boolean;
  truncated: boolean;
}

export interface MeProjection {
  fields: MeFieldChange[];
  /** Profile languages without a code or a CEFR level: shown as not applied, never guessed. */
  languagesNotApplied: string[];
}

const ME_SUMMARY_MAX_CHARS = 4000;

function languages(profile: CareerProfile): { value: MeConfig["languages"]; notApplied: string[] } {
  const seen = new Set<string>();
  const value: MeConfig["languages"] = [];
  const notApplied: string[] = [];
  for (const language of profile.languages) {
    if (language.code === null || language.cefr === null) {
      notApplied.push(language.name);
      continue;
    }
    if (seen.has(language.code)) continue;
    seen.add(language.code);
    value.push({ [language.code]: language.cefr });
  }
  return { value, notApplied };
}

function skills(profile: CareerProfile, scrub: (text: string) => string): MeConfig["skills"] {
  const merged = new Map<string, { name: string; years: number | null }>();
  for (const group of profile.skills) {
    for (const item of group.items) {
      const name = scrub(item.name).trim();
      if (name === "") continue;
      const key = name.toLocaleLowerCase();
      const known = merged.get(key);
      if (!known) merged.set(key, { name, years: item.years });
      else if (item.years !== null && (known.years === null || item.years > known.years)) known.years = item.years;
    }
  }
  return [...merged.values()];
}

/** What the profile proposes for each me.yaml field, against the current values. `today` is an ISO date. */
export function projectMe(profile: CareerProfile, current: MeConfig, today: string, scrub: (text: string) => string): MeProjection {
  const projectedLanguages = languages(profile);
  const years = yearsOfExperience(profile.experience, today);
  const summaryText = scrub(primaryText(profile.summary)).trim();
  const summary = summaryText.length > ME_SUMMARY_MAX_CHARS ? summaryText.slice(0, ME_SUMMARY_MAX_CHARS) : summaryText;
  const change = <F extends MeField>(field: F, proposed: MeConfig[F], defaultSelected: boolean, truncated = false): MeFieldChange =>
    ({ field, current: current[field], proposed, changed: !isDeepStrictEqual(current[field], proposed), defaultSelected, truncated }) as MeFieldChange;
  const fields: MeFieldChange[] = [];
  if (projectedLanguages.value.length > 0) fields.push(change("languages", projectedLanguages.value, true));
  const projectedSkills = skills(profile, scrub);
  if (projectedSkills.length > 0) fields.push(change("skills", projectedSkills, true));
  if (years !== null) fields.push(change("years_experience", years, true));
  if (summary !== "") fields.push(change("summary", summary, false, summary.length < summaryText.length));
  return { fields, languagesNotApplied: projectedLanguages.notApplied };
}

/** me.yaml with the selected, changed fields replaced. */
export function applyMeSelection(current: MeConfig, projection: MeProjection, selection: MeSelection): MeConfig {
  const next: MeConfig = { ...current };
  for (const change of projection.fields) {
    if (change.changed && selection[change.field]) (next as Record<MeField, unknown>)[change.field] = change.proposed;
  }
  return next;
}

export function defaultMeSelection(projection: MeProjection): MeSelection {
  const selection: MeSelection = { languages: false, skills: false, years_experience: false, summary: false };
  for (const change of projection.fields) selection[change.field] = change.changed && change.defaultSelected;
  return selection;
}
