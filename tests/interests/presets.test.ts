/** Presets as add-dialog drafts, unique ids, and the "can never match" warning. */
import { describe, expect, it } from "vitest";

import { interestsWarnings } from "@/lib/config";
import type { SignalPreset } from "@/lib/config/schemas/signal-presets";
import { presetLanguages, presetOptions, presetToDraft, uniquePresetId } from "@/lib/interests/presets";
import { newCategoryDraft } from "@/lib/interests/vocabulary-draft";

import { rawCategories, shippedInterests } from "../signals/helpers";

const preset: SignalPreset = {
  id: "perk",
  label: { en: "Perk", zh: "福利" },
  icon: "🎁",
  color: "violet",
  weight: 3,
  high_value: true,
  ai_confirm_only: false,
  ai_definition: "a perk",
  keywords: { en: ["perk", "bonus perk"], de: ["Vorteil"], fr: ["avantage"] },
  patterns: { en: ["\\bperks?\\b"], de: ["\\bVorteile?\\b"] },
  exclude: { de: ["\\bkein Vorteil\\b"] },
};

describe("presetToDraft / presetOptions", () => {
  it("takes English plus the market's language, nothing else, and keeps the other fields", () => {
    const draft = presetToDraft(preset, { languages: presetLanguages("de") });
    expect(draft).toMatchObject({ id: "perk", kind: "keyword", labelEn: "Perk", labelZh: "福利", icon: "🎁", color: "violet", weight: "3", highValue: true, aiDefinition: "a perk" });
    expect(draft.keywords).toEqual(["perk", "bonus perk", "Vorteil"]);
    expect(draft.patterns).toEqual(["\\bperks?\\b", "\\bVorteile?\\b"]);
    expect(draft.exclude).toEqual(["\\bkein Vorteil\\b"]);
  });

  it("an English market (or none) gets English only, once", () => {
    expect(presetLanguages("en")).toEqual(["en"]);
    expect(presetLanguages(null)).toEqual(["en"]);
    expect(presetOptions([preset], "EN")[0]?.draft.keywords).toEqual(["perk", "bonus perk"]);
  });

  it("newCategoryDraft keeps the dialog's id, kind, names and colour over the preset's", () => {
    const draft = newCategoryDraft({ id: "perk_2", kind: "keyword", labelZh: "", labelEn: "Mine", color: "olive" }, presetToDraft(preset, { languages: ["en"] }));
    expect(draft).toMatchObject({ id: "perk_2", labelEn: "Mine", labelZh: "", color: "olive", aiDefinition: "a perk", weight: "3", keywords: ["perk", "bonus perk"] });
    expect(newCategoryDraft({ id: "x", kind: "tag", labelZh: "", labelEn: "X", color: "slate" }).aiDefinition).toBe("");
  });
});

describe("uniquePresetId", () => {
  it("keeps a free id, suffixes a taken one (any case, active or deleted), stays within 24 characters", () => {
    expect(uniquePresetId("perk", ["T1", "T2"])).toBe("perk");
    expect(uniquePresetId("perk", ["PERK"])).toBe("perk_2");
    expect(uniquePresetId("perk", ["perk", "perk_2"])).toBe("perk_3");
    const long = "a".repeat(24);
    const next = uniquePresetId(long, [long]);
    expect(next).toHaveLength(24);
    expect(next.endsWith("_2")).toBe(true);
  });
});

describe("interestsWarnings", () => {
  const withWordless = (aiReview: boolean) =>
    shippedInterests((raw) => {
      rawCategories(raw).push({ id: "vibe", kind: "keyword", label: { en: "Vibe" }, color: "violet", weight: 1, ai_definition: "a friendly team" });
      (raw.limits as Record<string, unknown>).ai_review_without_candidates = aiReview;
    });

  it("warns about a keyword category without words only when jobs without rule hits skip the AI", () => {
    expect(interestsWarnings(withWordless(true))).toEqual([]);
    const warnings = interestsWarnings(withWordless(false));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "interests.semantic_only_unreachable" });
    expect(warnings[0]?.message).toContain('"vibe"');
  });
});
