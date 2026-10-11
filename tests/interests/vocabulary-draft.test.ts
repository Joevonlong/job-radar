// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry, type InterestsConfig } from "@/lib/config";
import {
  configToDraft,
  draftToCandidate,
  isValidCategoryId,
  isValidPattern,
  newCategoryDraft,
  toFieldErrors,
  type CategoryDraft,
  type VocabularyDraft,
  vocabularyDraftSchema,
} from "@/lib/interests/vocabulary-draft";

import { shippedInterests } from "../signals/helpers";

const schema = configRegistry.interests.schema;
const current = shippedInterests();

function merge(draft: VocabularyDraft, base: InterestsConfig = current) {
  const merged = draftToCandidate(draft, base);
  if (typeof merged === "string") throw new Error(`merge refused: ${merged}`);
  return merged;
}

function edited(change: (draft: VocabularyDraft) => void, base: InterestsConfig = current) {
  const draft = configToDraft(base);
  change(draft);
  const { candidate, draftPath, fieldErrors } = merge(draft, base);
  return { result: schema.safeParse(candidate), draftPath, fieldErrors };
}

const category = (draft: VocabularyDraft, id: string): CategoryDraft => {
  const found = draft.categories.find((c) => c.id === id);
  if (!found) throw new Error(`no category ${id}`);
  return found;
};

describe("vocabulary draft (categories)", () => {
  it("an untouched draft gives back exactly the current config", () => {
    const draft = configToDraft(current);
    expect(vocabularyDraftSchema.safeParse(draft).success).toBe(true);
    expect(schema.parse(merge(draft).candidate)).toEqual(current);
  });

  it("a changed keyword, weight, name, colour and high value end up in the config; fields the form does not show are kept", () => {
    const { result } = edited((draft) => {
      const t2 = category(draft, "T2");
      t2.keywords.push("Anteile");
      t2.weight = "12.5";
      t2.labelEn = "Shares";
      t2.color = "violet";
      category(draft, "T3").highValue = true;
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    const t2 = result.data.signals.categories.find((c) => c.id === "T2");
    expect(t2).toMatchObject({ kind: "keyword", weight: 12.5, label: { zh: "股权", en: "Shares" }, color: "violet", default_kind: "equity" });
    expect(t2?.kind === "keyword" && t2.keywords).toContain("Anteile");
    expect(result.data.signals.categories.find((c) => c.id === "T3")?.high_value).toBe(true);
    const amount = result.data.signals.categories.find((c) => c.kind === "amount");
    const before = current.signals.categories.find((c) => c.kind === "amount");
    expect(amount?.kind === "amount" && amount.amount).toEqual(before?.kind === "amount" && before.amount);
    expect(result.data.limits).toEqual(current.limits);
    expect(result.data.views).toEqual(current.views);
    expect(result.data.watched_companies).toEqual(current.watched_companies);
  });

  it("adds a new category, reorders, and leaves out empty optional fields", () => {
    const { result } = edited((draft) => {
      draft.categories.unshift({ ...newCategoryDraft({ id: "visa", kind: "keyword", labelZh: "签证担保", labelEn: "", color: "violet" }), keywords: ["visa sponsorship"], aiDefinition: "the employer sponsors a work visa", weight: "4" });
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.signals.categories.map((c) => c.id)).toEqual(["visa", "T1", "T2", "T3", "T4", "tag"]);
    expect(result.data.signals.categories[0]).toEqual({
      id: "visa",
      kind: "keyword",
      label: { zh: "签证担保" },
      color: "violet",
      weight: 4,
      high_value: false,
      ai_definition: "the employer sponsors a work visa",
      keywords: ["visa sponsorship"],
      patterns: [],
      exclude: [],
    });
  });

  it("deleting a saved category moves it, as saved, to the retired ones; restoring brings it back", () => {
    const draft = configToDraft(current);
    const t3 = category(draft, "T3");
    draft.categories = draft.categories.filter((c) => c.id !== "T3");
    draft.retired.push({ ...t3, weight: "99" }); // edits of a deleted category are dropped
    const { candidate } = merge(draft);
    const retired = schema.parse(candidate);
    expect(retired.signals.categories.map((c) => c.id)).toEqual(["T1", "T2", "T4", "tag"]);
    expect(retired.signals.retired_categories).toEqual([current.signals.categories.find((c) => c.id === "T3")]);

    const back = configToDraft(retired);
    back.categories.push(back.retired.pop() as CategoryDraft);
    const restored = schema.parse(merge(back, retired).candidate);
    expect(restored.signals.categories.map((c) => c.id)).toEqual(["T1", "T2", "T4", "tag", "T3"]);
    expect(restored.signals.retired_categories).toEqual([]);
  });

  it("refuses a draft that drops a saved id or retires one the file does not have", () => {
    const missing = configToDraft(current);
    missing.categories = missing.categories.filter((c) => c.id !== "T4");
    expect(draftToCandidate(missing, current)).toBe("categoryMissing");
    const unknown = configToDraft(current);
    unknown.retired.push(newCategoryDraft({ id: "ghost", kind: "tag", labelZh: "", labelEn: "Ghost", color: "neutral" }));
    expect(draftToCandidate(unknown, current)).toBe("unknownRetired");
  });

  it("keeps a saved category's kind (a field error), and rejects a retired id, a second amount category and a reserved id", () => {
    const { fieldErrors } = edited((draft) => {
      category(draft, "T2").kind = "tag";
    });
    expect(fieldErrors).toEqual([{ path: "categories.1.kind", key: "kindLocked" }]);

    const retired = schema.parse(
      merge({ ...configToDraft(current), categories: configToDraft(current).categories.filter((c) => c.id !== "T3"), retired: [category(configToDraft(current), "T3")] }).candidate,
    );
    const reuse = edited((draft) => {
      draft.categories.push({ ...newCategoryDraft({ id: "t3", kind: "keyword", labelZh: "", labelEn: "Again", color: "pink" }), aiDefinition: "again" });
    }, retired);
    expect(reuse.result.success).toBe(false);
    if (!reuse.result.success) expect(toFieldErrors(reuse.result.error, reuse.draftPath)).toEqual(expect.arrayContaining([{ path: "retired.0.id", key: "duplicates" }]));

    const amounts = edited((draft) => {
      draft.categories.push({ ...newCategoryDraft({ id: "pay", kind: "amount", labelZh: "", labelEn: "Pay", color: "amber" }), patterns: ["\\d+"], aiDefinition: "pay" });
      draft.categories.push(newCategoryDraft({ id: "Breakdown", kind: "tag", labelZh: "", labelEn: "B", color: "neutral" }));
    });
    expect(amounts.result.success).toBe(false);
    if (!amounts.result.success) {
      expect(toFieldErrors(amounts.result.error, amounts.draftPath)).toEqual(
        expect.arrayContaining([
          { path: "categories.5.kind", key: "amountTaken" },
          { path: "categories.6.id", key: "idReserved" },
        ]),
      );
    }
  });

  it("reports errors on the row the user typed it in, even when blank rows above it were dropped", () => {
    const { result, draftPath, fieldErrors } = edited((draft) => {
      category(draft, "T2").patterns = ["", "(unclosed", "fine"];
      category(draft, "T3").weight = "abc";
      category(draft, "T1").weight = "";
      category(draft, "T4").weight = "-2";
      category(draft, "T4").labelZh = "";
      category(draft, "T4").labelEn = " ";
      category(draft, "T2").icon = "💰💰💰";
      category(draft, "T3").aiDefinition = "";
      draft.bonusCap = "x";
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect([...fieldErrors, ...toFieldErrors(result.error, draftPath)]).toEqual(
      expect.arrayContaining([
        { path: "categories.1.patterns.1", key: "regex" },
        { path: "categories.2.weight", key: "number" },
        { path: "categories.0.weight", key: "required" },
        { path: "categories.3.weight", key: "min", params: { min: 0 } },
        { path: "categories.3.label", key: "nameRequired" },
        { path: "categories.1.icon", key: "iconTooLong" },
        { path: "categories.2.aiDefinition", key: "required" },
        { path: "bonusCap", key: "number" },
      ]),
    );
  });

  it("flags an empty amount pattern list, duplicate keywords and an incomplete tag pattern row", () => {
    const { result, draftPath } = edited((draft) => {
      category(draft, "T1").patterns = ["", " "];
      category(draft, "T2").keywords = ["equity", "equity"];
      category(draft, "tag").tagPatterns = [{ name: " ", pattern: "" }, { name: "gym", pattern: "" }];
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(toFieldErrors(result.error, draftPath)).toEqual(
      expect.arrayContaining([
        { path: "categories.0.patterns", key: "atLeastOne" },
        { path: "categories.1.keywords", key: "duplicates" },
        { path: "categories.4.tagPatterns.1.pattern", key: "required" },
      ]),
    );
  });

  it("rejects a payload that is not a draft, or a colour off the palette", () => {
    expect(vocabularyDraftSchema.safeParse({ categories: {} }).success).toBe(false);
    expect(vocabularyDraftSchema.safeParse({ ...configToDraft(current), extra: 1 }).success).toBe(false);
    const draft = configToDraft(current);
    expect(vocabularyDraftSchema.safeParse({ ...draft, categories: [{ ...draft.categories[0], color: "red" }] }).success).toBe(false);
  });

  it("checks patterns with the flags the rule stage uses, and ids with the category format", () => {
    expect(isValidPattern("\\bequity\\b")).toBe(true);
    expect(isValidPattern("(?<![\\p{L}])x")).toBe(true);
    expect(isValidPattern("(")).toBe(false);
    expect(isValidCategoryId("visa_2")).toBe(true);
    expect(isValidCategoryId("2visa")).toBe(false);
    expect(isValidCategoryId("a".repeat(25))).toBe(false);
  });
});
