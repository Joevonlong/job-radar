/**
 * The presets of the "add a category" dialog (config/signal-presets.yaml) as form drafts. A preset becomes a
 * `keyword` category draft with the word lists of English plus the market's local language; everything stays editable and
 * the save checks it like any other category. Pure: the server expands the presets, the dialog only makes the id unique.
 */
import type { SignalPreset } from "@/lib/config/schemas/signal-presets";

import type { CategoryDraft } from "./vocabulary-draft";

export interface PresetOption {
  id: string;
  labelEn: string;
  labelZh: string;
  /** The category the preset fills in (its id may still be taken: see `uniquePresetId`). */
  draft: CategoryDraft;
}

/** English first, then the market's language (deduplicated, lower case). */
export function presetLanguages(homeLanguage: string | null): string[] {
  return [...new Set(["en", ...(homeLanguage ? [homeLanguage.toLowerCase()] : [])])];
}

const pick = (lists: Readonly<Record<string, readonly string[]>>, languages: readonly string[]): string[] => [...new Set(languages.flatMap((language) => lists[language] ?? []))];

export function presetToDraft(preset: SignalPreset, options: { languages: readonly string[] }): CategoryDraft {
  return {
    id: preset.id,
    kind: "keyword",
    labelZh: preset.label.zh ?? "",
    labelEn: preset.label.en ?? "",
    icon: preset.icon ?? "",
    color: preset.color,
    weight: String(preset.weight),
    highValue: preset.high_value,
    aiConfirmOnly: preset.ai_confirm_only,
    aiDefinition: preset.ai_definition,
    keywords: pick(preset.keywords, options.languages),
    patterns: pick(preset.patterns, options.languages),
    exclude: pick(preset.exclude, options.languages),
    tags: [],
    tagPatterns: [],
  };
}

export function presetOptions(presets: readonly SignalPreset[], homeLanguage: string | null): PresetOption[] {
  const languages = presetLanguages(homeLanguage);
  return presets.map((preset) => ({ id: preset.id, labelEn: preset.label.en ?? "", labelZh: preset.label.zh ?? "", draft: presetToDraft(preset, { languages }) }));
}

/** The preset's id, or with `_2`, `_3` ... when a category (active or deleted) already has it; never longer than 24 characters. */
export function uniquePresetId(id: string, taken: readonly string[]): string {
  const used = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!used.has(id.toLowerCase())) return id;
  for (let n = 2; n < 100; n += 1) {
    const suffix = `_${n}`;
    const candidate = `${id.slice(0, 24 - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return id;
}
