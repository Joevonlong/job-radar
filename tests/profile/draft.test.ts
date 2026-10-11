import { describe, expect, it } from "vitest";

import { meSchema } from "@/lib/config/schemas/me";
import { preferencesSchema } from "@/lib/config/schemas/preferences";
import {
  CONTRACT_OPTIONS,
  LANGUAGE_LEVEL_OPTIONS,
  REMOTE_SCOPE_KINDS,
  SENIORITY_OPTIONS,
  WORKPLACE_OPTIONS,
  meConfigToDraft,
  meDraftToCandidate,
  preferencesConfigToDraft,
  preferencesDraftToCandidate,
  toFieldErrors,
  type DealBreakerDraft,
  type MeDraft,
  type PreferencesDraft,
} from "@/lib/profile/draft";

const ME: MeDraft = {
  languages: [
    { code: "en", level: "C1" },
    { code: "de", level: "B1" },
  ],
  skills: [{ name: "Python", years: "5" }],
  years_experience: "8",
  city: "Berlin",
  needs_visa_sponsorship: false,
  summary: "Backend engineer.",
};

const PREFS: PreferencesDraft = {
  market: { pack: "de", country: "", currency: "", home_language: "" },
  target_titles: ["AI Engineer"],
  locations: ["Berlin"],
  workplace: ["hybrid", "remote"],
  remote_scope: "home_country",
  seniority: "all",
  salary_floor_year: "70000",
  contracts: { permanent: "allow", fixed_term: "allow", freelance: "none", temp_agency: "exclude" },
  exclude_student_roles: true,
  exclude_companies: [],
  exclude_keywords: ["Werkstudent"],
  deal_breakers: [],
};

function meErrors(draft: MeDraft) {
  const result = meSchema.safeParse(meDraftToCandidate(draft));
  return result.success ? [] : toFieldErrors(result.error);
}
function prefErrors(draft: PreferencesDraft) {
  const result = preferencesSchema.safeParse(preferencesDraftToCandidate(draft));
  return result.success ? [] : toFieldErrors(result.error);
}

describe("option lists mirror the config schemas", () => {
  it("matches the zod enums", () => {
    expect([...LANGUAGE_LEVEL_OPTIONS]).toEqual(["A1", "A2", "B1", "B2", "C1", "C2", "native"]);
    const prefs = preferencesSchema.shape;
    expect([...SENIORITY_OPTIONS]).toEqual(prefs.seniority.options);
    // the kinds of remote scope: the three plain values of the schema plus `region` (a list)
    const plain = (prefs.remote_scope.options[0] as { options: readonly string[] }).options;
    expect([...REMOTE_SCOPE_KINDS]).toEqual([...plain, "region"]);
    expect([...WORKPLACE_OPTIONS]).toEqual(prefs.workplace.element.options);
    expect([...CONTRACT_OPTIONS]).toEqual(prefs.contracts.shape.allow.element.options);
  });
});

describe("me draft", () => {
  it("round-trips through the config shape", () => {
    const parsed = meSchema.parse(meDraftToCandidate(ME));
    expect(meConfigToDraft(parsed)).toEqual(ME);
  });

  it("maps empty numeric text to null and lowercases language codes", () => {
    const parsed = meSchema.parse(
      meDraftToCandidate({ ...ME, years_experience: " ", skills: [{ name: "Go", years: "" }], languages: [{ code: " EN ", level: "C1" }] }),
    );
    expect(parsed.years_experience).toBeNull();
    expect(parsed.skills[0]?.years).toBeNull();
    expect(parsed.languages).toEqual([{ en: "C1" }]);
  });

  it("reports errors by draft path with translatable keys", () => {
    const errors = meErrors({
      ...ME,
      languages: [{ code: "english", level: "C1" }, { code: "de", level: "Z9" }],
      skills: [{ name: "", years: "-2" }, { name: "Go", years: "lots" }],
      years_experience: "1,5",
      city: " ",
      summary: "x".repeat(4001),
    });
    const by = Object.fromEntries(errors.map((e) => [e.path, e.key]));
    expect(by["languages.0"]).toBe("languageCode");
    expect(by["languages.1"]).toBe("invalidChoice");
    expect(by["skills.0.name"]).toBe("required");
    expect(by["skills.0.years"]).toBe("min");
    expect(by["skills.1.years"]).toBe("number");
    expect(by["years_experience"]).toBe("number");
    expect(by["city"]).toBe("required");
    expect(by["summary"]).toBe("tooLong");
    expect(errors.find((e) => e.path === "summary")?.params).toEqual({ max: 4000 });
  });
});

describe("preferences draft", () => {
  it("round-trips through the config shape", () => {
    const parsed = preferencesSchema.parse(preferencesDraftToCandidate(PREFS));
    expect(preferencesConfigToDraft(parsed)).toEqual(PREFS);
  });

  it("derives contract allow/exclude lists from the per-kind modes", () => {
    const parsed = preferencesSchema.parse(preferencesDraftToCandidate(PREFS));
    expect(parsed.contracts).toEqual({ allow: ["permanent", "fixed_term"], exclude: ["temp_agency"] });
    expect(parsed.workplace).toEqual(["hybrid", "remote"]);
  });

  it("reports a negative or fractional salary floor on its own field", () => {
    expect(prefErrors({ ...PREFS, salary_floor_year: "-5" })).toEqual([
      { path: "salary_floor_year", key: "min", params: { min: 0 } },
    ]);
    expect(prefErrors({ ...PREFS, salary_floor_year: "70000.5" })[0]).toMatchObject({ path: "salary_floor_year", key: "integer" });
    expect(prefErrors({ ...PREFS, salary_floor_year: "" })[0]).toMatchObject({ path: "salary_floor_year", key: "required" });
    expect(prefErrors({ ...PREFS, salary_floor_year: "70k" })[0]).toMatchObject({ path: "salary_floor_year", key: "number" });
  });

  it("attributes list errors to the list, not the item", () => {
    const errors = prefErrors({ ...PREFS, target_titles: [], locations: ["a", "a"], workplace: [], exclude_companies: [" "] });
    const by = Object.fromEntries(errors.map((e) => [e.path, e.key]));
    expect(by["target_titles"]).toBe("atLeastOne");
    expect(by["locations"]).toBe("duplicates");
    expect(by["workplace"]).toBe("atLeastOne");
    expect(by["exclude_companies"]).toBe("required");
  });

  it("reports an invalid select value", () => {
    const by = Object.fromEntries(prefErrors({ ...PREFS, remote_scope: "mars", seniority: "god" }).map((e) => [e.path, e.key]));
    expect(by["remote_scope"]).toBe("invalidChoice");
    expect(by["seniority"]).toBe("invalidChoice");
  });
});

describe("deal-breakers in the preferences draft", () => {
  const blank: Omit<DealBreakerDraft, "id" | "label" | "type"> = { enabled: true, at_least: "", terms: [], patterns: [], scope: "any", unless: [] };
  const gate: DealBreakerDraft = { ...blank, id: "language-gate", label: "German above my level", type: "language_gate" };
  const phrase: DealBreakerDraft = { ...blank, id: "travel", label: "Lots of travel", type: "phrase", terms: ["travel"], unless: ["\\bno travel\\b"], scope: "description" };

  it("round-trips both types, writing only the fields of the type and no defaults", () => {
    const draft = { ...PREFS, deal_breakers: [gate, { ...phrase, enabled: false }, { ...gate, id: "c1", label: "C1", at_least: "C1" }] };
    const candidate = preferencesDraftToCandidate(draft) as { deal_breakers: unknown[] };
    expect(candidate.deal_breakers).toEqual([
      { id: "language-gate", label: "German above my level", type: "language_gate" },
      { id: "travel", label: "Lots of travel", type: "phrase", enabled: false, terms: ["travel"], scope: "description", unless: ["\\bno travel\\b"] },
      { id: "c1", label: "C1", type: "language_gate", at_least: "C1" },
    ]);
    expect(preferencesConfigToDraft(preferencesSchema.parse(candidate))).toEqual(draft);
  });

  it("drops the fields of the other type when the type changes", () => {
    const candidate = preferencesDraftToCandidate({ ...PREFS, deal_breakers: [{ ...phrase, type: "language_gate" }] }) as { deal_breakers: unknown[] };
    expect(candidate.deal_breakers).toEqual([{ id: "travel", label: "Lots of travel", type: "language_gate" }]);
  });

  it("reports errors on the rule's field", () => {
    const by = Object.fromEntries(
      prefErrors({ ...PREFS, deal_breakers: [gate, { ...gate, label: "" }, { ...phrase, id: "p", terms: [], patterns: [] }, { ...phrase, id: "q", patterns: ["(a+)+"] }] }).map((e) => [e.path, e.key]),
    );
    expect(by).toEqual({ "deal_breakers.1.id": "duplicates", "deal_breakers.1.label": "required", "deal_breakers.2.terms": "atLeastOne", "deal_breakers.3.patterns": "slowPattern" });
  });

  it("reports too many rules on the list", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ ...gate, id: `g${i}` }));
    expect(prefErrors({ ...PREFS, deal_breakers: many })).toEqual([{ path: "deal_breakers", key: "tooMany", params: { max: 50 } }]);
  });
});
