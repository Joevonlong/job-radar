import { describe, expect, it } from "vitest";

import type { InterestsConfig } from "@/lib/config";
import { applySuggestion, SuggestionCategoryMissing } from "@/lib/interests/suggestion-apply";
import { dedupeKeyOf, normalizeTerm, suggestedValue, suggestionPayloadSchema, type SuggestionPayload } from "@/lib/interests/suggestion";

import { examplePreferences } from "../scoring/helpers";
import { shippedInterests } from "../signals/helpers";
import { normalizeCompany } from "./helpers";

const keywordsOf = (interests: InterestsConfig, id: string): string[] => {
  const category = interests.signals.categories.find((c) => c.id === id);
  return category?.kind === "keyword" ? category.keywords : [];
};
const tagsOf = (interests: InterestsConfig, id: string): string[] => {
  const category = interests.signals.categories.find((c) => c.id === id);
  return category?.kind === "tag" ? category.tags : [];
};
const base = { reasonZh: "理由", reasonEn: "reason", confidence: 0.7, evidence: [{ jobId: 1, title: "t", company: "c" }] };
const word = (over: Record<string, unknown> = {}): SuggestionPayload => suggestionPayloadSchema.parse({ kind: "signal_word", tier: "T2", term: "phantom units", ...base, ...over });
const company = (name: string): SuggestionPayload => suggestionPayloadSchema.parse({ kind: "watched_company", company: name, ...base });
const filter = (action: string, value: string): SuggestionPayload => suggestionPayloadSchema.parse({ kind: "filter", action, value, ...base });

describe("payload schema", () => {
  it("accepts the three kinds and refuses unknown tiers, actions, extra keys and empty evidence", () => {
    expect(word().kind).toBe("signal_word");
    expect(company("Acme").kind).toBe("watched_company");
    expect(filter("add_location", "Hamburg").kind).toBe("filter");
    // a category id or the old `benefit_tag`; anything else is not an id
    expect(suggestionPayloadSchema.safeParse({ kind: "signal_word", tier: "visa", term: "x", ...base }).success).toBe(true);
    expect(suggestionPayloadSchema.safeParse({ kind: "signal_word", tier: "benefit_tag", term: "x", ...base }).success).toBe(true);
    expect(suggestionPayloadSchema.safeParse({ kind: "signal_word", tier: "not an id", term: "x", ...base }).success).toBe(false);
    expect(suggestionPayloadSchema.safeParse({ kind: "filter", action: "delete_everything", value: "x", ...base }).success).toBe(false);
    expect(suggestionPayloadSchema.safeParse({ kind: "watched_company", company: "x", ...base, extra: 1 }).success).toBe(false);
    expect(suggestionPayloadSchema.safeParse({ kind: "watched_company", company: "x", ...base, evidence: [] }).success).toBe(false);
    expect(suggestionPayloadSchema.safeParse({ kind: "watched_company", company: "x", ...base, confidence: 1.5 }).success).toBe(false);
  });
});

describe("dedupe keys", () => {
  it("fold case and spacing, and ignore the tier of a word", () => {
    expect(normalizeTerm("  Stock   OPTIONS ")).toBe("stock options");
    expect(dedupeKeyOf(word({ term: "Phantom  Units" }), normalizeCompany)).toBe(dedupeKeyOf(word({ tier: "T4", term: "phantom units" }), normalizeCompany));
  });

  it("join company spellings and tell kinds and actions apart", () => {
    expect(dedupeKeyOf(company("Acme AI GmbH"), normalizeCompany)).toBe(dedupeKeyOf(company("acme ai"), normalizeCompany));
    const keys = [word(), company("phantom units"), filter("exclude_keyword", "phantom units"), filter("exclude_company", "phantom units")].map((p) => dedupeKeyOf(p, normalizeCompany));
    expect(new Set(keys).size).toBe(4);
    expect(suggestedValue(filter("add_location", "Hamburg"))).toBe("Hamburg");
  });
});

describe("applySuggestion", () => {
  const current = () => ({ interests: shippedInterests(), preferences: examplePreferences() });

  it("puts a word into the keyword list of its category, or the tags of a tag category (the old `benefit_tag`: the first one)", () => {
    const t2 = applySuggestion(word(), current(), normalizeCompany);
    expect(t2).toMatchObject({ interestsChanged: true, preferencesChanged: false });
    expect(keywordsOf(t2.interests, "T2").at(-1)).toBe("phantom units");
    const tag = applySuggestion(word({ tier: "benefit_tag", term: "gym" }), current(), normalizeCompany);
    expect(tagsOf(tag.interests, "tag").at(-1)).toBe("gym");
    expect(keywordsOf(tag.interests, "T2")).toEqual(keywordsOf(current().interests, "T2"));
    expect(tagsOf(applySuggestion(word({ tier: "tag", term: "sauna" }), current(), normalizeCompany).interests, "tag").at(-1)).toBe("sauna");
  });

  it("refuses a word whose category was deleted or is the amount category", () => {
    expect(() => applySuggestion(word({ tier: "visa" }), current(), normalizeCompany)).toThrow(SuggestionCategoryMissing);
    expect(() => applySuggestion(word({ tier: "T1" }), current(), normalizeCompany)).toThrow(SuggestionCategoryMissing);
  });

  it("adds a watched company unless it is there under another spelling", () => {
    const added = applySuggestion(company("Acme AI"), current(), normalizeCompany);
    expect(added.interests.watched_companies).toEqual(["Acme AI"]);
    const again = applySuggestion(company("ACME AI GmbH"), { ...current(), interests: added.interests }, normalizeCompany);
    expect(again).toMatchObject({ interestsChanged: false, preferencesChanged: false });
  });

  it("changes preferences.yaml for the three filter actions", () => {
    const before = current().preferences;
    const kw = applySuggestion(filter("exclude_keyword", "Cobol"), current(), normalizeCompany);
    expect(kw).toMatchObject({ interestsChanged: false, preferencesChanged: true });
    expect(kw.preferences.exclude_keywords).toEqual([...before.exclude_keywords, "Cobol"]);
    expect(applySuggestion(filter("add_location", "Hamburg"), current(), normalizeCompany).preferences.locations).toEqual([...before.locations, "Hamburg"]);
    expect(applySuggestion(filter("exclude_company", "Legacy Bank"), current(), normalizeCompany).preferences.exclude_companies).toEqual([...before.exclude_companies, "Legacy Bank"]);
  });

  it("changes nothing when the value is already listed, and never mutates its input", () => {
    const input = current();
    const frozen = Object.freeze(input.interests);
    expect(applySuggestion(filter("add_location", "berlin"), input, normalizeCompany)).toMatchObject({ preferencesChanged: false });
    expect(applySuggestion(word({ tier: "benefit_tag", term: "JOBRAD" }), input, normalizeCompany)).toMatchObject({ interestsChanged: false });
    applySuggestion(word(), { interests: frozen, preferences: input.preferences }, normalizeCompany);
    expect(keywordsOf(input.interests, "T2")).not.toContain("phantom units");
  });
});
