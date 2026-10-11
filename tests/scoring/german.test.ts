// @vitest-environment node
import { describe, expect, it } from "vitest";

import { explicitGermanLevels, languagePenalty, penalizedLanguageLevels, resolveGermanLevel, userLanguageLabel, userLanguageRank } from "@/lib/scoring/german";

/** The German market's local language. */
const DE = "de";
const germanPenalty = (level: Parameters<typeof languagePenalty>[0], me: Parameters<typeof languagePenalty>[1], t: Parameters<typeof languagePenalty>[2]) => languagePenalty(level, me, t, DE);
const userGermanRank = (me: Parameters<typeof userLanguageRank>[0]) => userLanguageRank(me, DE);
const userGermanLabel = (me: Parameters<typeof userLanguageLabel>[0]) => userLanguageLabel(me, DE);
const penalizedGermanLevels = (me: Parameters<typeof penalizedLanguageLevels>[0], t: Parameters<typeof penalizedLanguageLevels>[1]) => penalizedLanguageLevels(me, t, DE);

import { aiConfig, exampleMe } from "./helpers";

const table = aiConfig().scoring.language_penalty;
const meWith = (german: string | null) =>
  exampleMe((raw) => {
    raw.languages = german === null ? [{ en: "C1" }] : [{ en: "C1" }, { de: german }];
  });

describe("language_penalty defaults (ai.yaml)", () => {
  it("is B2 -10, C1 -20, C2 -25", () => {
    expect(table).toEqual({ B2: 10, C1: 20, C2: 25 });
  });
});

describe("germanPenalty", () => {
  const b1 = meWith("B1");

  it.each([
    ["B2", 10],
    ["C1", 20],
    ["C2", 25],
  ] as const)("a posting requiring %s costs %i points for a B1 speaker", (level, points) => {
    expect(germanPenalty(level, b1, table)).toBe(points);
  });

  it.each(["unknown", "none", "A1", "A2", "B1"] as const)("%s costs nothing for a B1 speaker", (level) => {
    expect(germanPenalty(level, b1, table)).toBe(0);
  });

  it("costs nothing at or below the user's own level", () => {
    expect(germanPenalty("B2", meWith("B2"), table)).toBe(0);
    expect(germanPenalty("C1", meWith("B2"), table)).toBe(20);
    expect(germanPenalty("C2", meWith("C2"), table)).toBe(0);
    expect(germanPenalty("C2", meWith("native"), table)).toBe(0);
  });

  it("costs the full amount when the user lists no German", () => {
    expect(germanPenalty("B2", meWith(null), table)).toBe(10);
  });

  it("reads the amounts from the config, and a level without an entry is free", () => {
    expect(germanPenalty("B2", b1, { B2: 3 })).toBe(3);
    expect(germanPenalty("C1", b1, { B2: 3 })).toBe(0);
  });
});

describe("local language off", () => {
  it("costs nothing, hides nothing when the market has no language step", () => {
    expect(languagePenalty("C2", meWith(null), table, null)).toBe(0);
    expect(penalizedLanguageLevels(meWith(null), table, null)).toEqual([]);
  });

  it("reads the user's level of the market's language, not German", () => {
    const fr = exampleMe((raw) => void (raw.languages = [{ en: "C1" }, { fr: "C1" }, { de: "A1" }]));
    expect(userLanguageRank(fr, "fr")).toBe(4);
    expect(languagePenalty("C1", fr, table, "fr")).toBe(0);
    expect(languagePenalty("C1", fr, table, "de")).toBe(20);
  });
});

describe("user level", () => {
  it("ranks and labels the German entry of me.yaml", () => {
    expect(userGermanRank(meWith("B1"))).toBe(2);
    expect(userGermanLabel(meWith("B1"))).toBe("B1");
    expect(userGermanLabel(meWith("native"))).toBe("native");
    expect(userGermanLabel(meWith(null))).toBe("none");
  });
});

describe("penalizedGermanLevels", () => {
  it("lists the levels above the user's that cost points", () => {
    expect(penalizedGermanLevels(meWith("B1"), table)).toEqual(["B2", "C1", "C2"]);
    expect(penalizedGermanLevels(meWith("B2"), table)).toEqual(["C1", "C2"]);
    expect(penalizedGermanLevels(meWith("native"), table)).toEqual([]);
  });

  it("falls back to every level with a deduction when me.yaml is unavailable", () => {
    expect(penalizedGermanLevels(null, table)).toEqual(["B2", "C1", "C2"]);
    expect(penalizedGermanLevels(null, { C1: 20 })).toEqual(["C1"]);
  });
});

describe("explicitGermanLevels", () => {
  it("leaves out levels that are only a plus, preferred or not required", () => {
    expect([...explicitGermanLevels("German C1 is a plus. Deutsch B2 erforderlich.")]).toEqual(["B2"]);
    expect([...explicitGermanLevels("Preferred Qualifications: German C1")]).toEqual([]);
  });

  it("finds CEFR levels named next to German / Deutsch", () => {
    expect([...explicitGermanLevels("You speak fluent German (C1) and English C1.")]).toEqual(["C1"]);
    expect([...explicitGermanLevels("Deutsch B2 erforderlich. English C1")]).toEqual(["B2"]);
    expect([...explicitGermanLevels("C1 German; B2 Deutsch")].sort()).toEqual(["B2", "C1"]);
  });

  it("ignores levels in clauses that do not talk about German", () => {
    expect(explicitGermanLevels("English C1 required. Vitamin B2 is nice.").size).toBe(0);
    expect(explicitGermanLevels("We are in Deutschland and need C1 English").size).toBe(0);
  });
});

describe("resolveGermanLevel", () => {
  const jd = (text: string) => text;

  it("agrees when rule and AI say the same", () => {
    expect(resolveGermanLevel({ rule: "C1", ai: "C1", jdText: jd("German C1") })).toEqual({ level: "C1", source: "agree" });
    expect(resolveGermanLevel({ rule: "unknown", ai: "unknown", jdText: "" })).toEqual({ level: "unknown", source: "agree" });
  });

  it("takes the one that says something when the other is unknown", () => {
    expect(resolveGermanLevel({ rule: "unknown", ai: "B2", jdText: "gute Deutschkenntnisse" })).toEqual({ level: "B2", source: "ai" });
    expect(resolveGermanLevel({ rule: "C1", ai: "unknown", jdText: "" })).toEqual({ level: "C1", source: "rule" });
  });

  it("prefers the reading the JD states explicitly when they differ", () => {
    expect(resolveGermanLevel({ rule: "B2", ai: "C1", jdText: jd("Fließend Deutsch (C1) wird erwartet.") })).toEqual({ level: "C1", source: "ai_explicit" });
    expect(resolveGermanLevel({ rule: "C1", ai: "B2", jdText: jd("German C1 is required for this role.") })).toEqual({ level: "C1", source: "rule_explicit" });
  });

  it("keeps the rule value when both levels are named explicitly", () => {
    expect(resolveGermanLevel({ rule: "C1", ai: "B2", jdText: jd("German C1 for clients, German B2 for internal work") })).toEqual({ level: "C1", source: "rule_preferred" });
  });

  it("keeps the rule value when neither level is named explicitly", () => {
    expect(resolveGermanLevel({ rule: "C1", ai: "B2", jdText: jd("Verhandlungssichere Deutschkenntnisse") })).toEqual({ level: "C1", source: "rule_preferred" });
  });

  it("keeps an explicit 'not required' reading of the rule over an AI level", () => {
    expect(resolveGermanLevel({ rule: "none", ai: "B2", jdText: jd("German B2 is a plus") })).toEqual({ level: "none", source: "rule_preferred" });
  });

  it("keeps a 'preferred' reading of the rule over an AI level (Quantexa: Preferred Qualifications, Fluent in German)", () => {
    expect(resolveGermanLevel({ rule: "preferred", ai: "C1", jdText: jd("Preferred Qualifications Fluent in German and English") })).toEqual({ level: "preferred", source: "rule_preferred" });
    expect(resolveGermanLevel({ rule: "preferred", ai: "unknown", jdText: jd("German is a plus") })).toEqual({ level: "preferred", source: "rule" });
    expect(resolveGermanLevel({ rule: "unknown", ai: "preferred", jdText: jd("") })).toEqual({ level: "preferred", source: "ai" });
  });

  it("takes the level the rule now reads from the wording over an AI 'none' (wording: Verhandlungssicheres Deutsch)", () => {
    expect(resolveGermanLevel({ rule: "C1", ai: "none", jdText: jd("Verhandlungssicheres Deutsch in Wort und Schrift") })).toEqual({ level: "C1", source: "rule_preferred" });
    expect(resolveGermanLevel({ rule: "C1", ai: "C1", jdText: jd("Verhandlungssicheres Deutsch in Wort und Schrift") })).toEqual({ level: "C1", source: "agree" });
  });

  it("does not count a CEFR level that is only 'a plus' as the explicit reading of the JD", () => {
    // the rule read "fließend" (C1); the AI picked up "B2" from a line that says B2 is a plus: the explicit B2 is no requirement
    expect(resolveGermanLevel({ rule: "C1", ai: "B2", jdText: jd("Fließend Deutsch erforderlich. B2 German is a plus for the Swiss office.") })).toEqual({ level: "C1", source: "rule_preferred" });
  });
});
