import { describe, expect, it } from "vitest";

import type { SuggestOutput } from "@/lib/ai/prompts/suggest";
import { cleanTerm, quoteInText, validateSuggestions } from "@/lib/interests/suggest-validate";

import { shippedInterests } from "../signals/helpers";
import { context, emptyOutput, reasons, shippedSuggest, sourceJob } from "./helpers";

const liked = [
  sourceJob({ jobId: 1, companyName: "Northwind Labs GmbH", companyNorm: "northwind-labs", description: "We build LLM products.\nWe offer a Wellness budget after three years and a JobRad lease." }),
  sourceJob({ jobId: 2, companyName: "Northwind Labs", companyNorm: "northwind-labs", description: "Our team is remote friendly. We offer a  Wellness budget\nafter three years." }),
  sourceJob({ jobId: 3, companyName: "Acme AI", companyNorm: "acme-ai", description: "Build agents in Berlin. Competitive pay is guaranteed.", locationsJson: [{ label: "Hamburg", city: "Hamburg", countryCode: "DE", isPrimary: true }] }),
  sourceJob({ jobId: 4, companyName: "Hamburg Robotics", companyNorm: "hamburg-robotics", description: "Robots in Hamburg.", locationsJson: [{ label: "Hamburg, Germany", city: "Hamburg", countryCode: "DE", isPrimary: true }] }),
];
const ignored = [
  sourceJob({ jobId: 11, title: "Senior Cobol Developer", companyName: "Legacy Bank AG", companyNorm: "legacy-bank", description: "Maintain Cobol systems at the bank.", applicationStatus: "archived" }),
  sourceJob({ jobId: 12, title: "Cobol Architect", companyName: "Legacy Bank", companyNorm: "legacy-bank", description: "Design Cobol mainframe landscapes.", applicationStatus: "archived" }),
];

const ctx = (extra = {}) => context({ positive: liked, ignored, ...extra });
const word = (over: Partial<SuggestOutput["signal_words"][number]> = {}): SuggestOutput["signal_words"][number] => ({
  tier: "benefit_tag",
  term: "Wellness budget",
  ...reasons,
  evidence: [
    { job_id: 1, quote: "We offer a Wellness budget after three years" },
    { job_id: 2, quote: "We offer a Wellness budget after three years" },
  ],
  ...over,
});

const only = (output: Partial<SuggestOutput>): SuggestOutput => ({ ...emptyOutput(), ...output });

describe("helpers", () => {
  it("quoteInText ignores line breaks and runs of spaces but not wording", () => {
    expect(quoteInText("a Wellness budget after three years", liked[1]!.description)).toBe(true);
    expect(quoteInText("a wellness budget after three years", liked[1]!.description)).toBe(false);
    expect(quoteInText("", "x")).toBe(false);
  });

  it("cleanTerm trims, strips quotes and refuses empty, long or letterless terms", () => {
    expect(cleanTerm('  "stock   options" ', 60)).toBe("stock options");
    expect(cleanTerm("x", 60)).toBeNull();
    expect(cleanTerm("a".repeat(61), 60)).toBeNull();
    expect(cleanTerm("1234", 60)).toBeNull();
  });
});

describe("signal words", () => {
  it("accepts a word whose quotes are verbatim in at least min_evidence liked jobs, with the evidence attached", () => {
    const { accepted, dropped } = validateSuggestions(only({ signal_words: [word()] }), ctx());
    expect(dropped).toEqual({});
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.dedupeKey).toBe("signal_word:wellness budget");
    // an answer naming the old `benefit_tag` goes into the first tag category
    expect(accepted[0]?.payload).toMatchObject({ kind: "signal_word", tier: "tag", term: "Wellness budget", confidence: 0.8 });
    const evidence = accepted[0]?.payload.evidence ?? [];
    expect(evidence.map((e) => e.jobId)).toEqual([1, 2]);
    expect(evidence[0]).toMatchObject({ title: liked[0]?.title, company: "Northwind Labs GmbH", quote: "We offer a Wellness budget after three years" });
  });

  it("drops a quote that is not in the JD, so a made-up quote cannot back a suggestion", () => {
    const made = word({ evidence: [{ job_id: 1, quote: "We offer a Wellness budget after three years" }, { job_id: 2, quote: "A two month wellness budget for everyone" }] });
    const { accepted, dropped } = validateSuggestions(only({ signal_words: [made] }), ctx());
    expect(accepted).toEqual([]);
    expect(dropped).toEqual({ too_little_evidence: 1 });
  });

  it("drops evidence that is not a liked job or does not contain the term, and counts a job once", () => {
    const bad = word({
      evidence: [
        { job_id: 11, quote: "Maintain Cobol systems at the bank." },
        { job_id: 1, quote: "We build LLM products." },
        { job_id: 1, quote: "We offer a Wellness budget after three years" },
        { job_id: 1, quote: "a Wellness budget after three years" },
        { job_id: 999, quote: "We offer a Wellness budget after three years" },
      ],
    });
    const { accepted, dropped } = validateSuggestions(only({ signal_words: [bad] }), ctx());
    expect(accepted).toEqual([]);
    expect(dropped).toEqual({ too_little_evidence: 1 });
  });

  it("says no_valid_evidence when nothing was cited", () => {
    expect(validateSuggestions(only({ signal_words: [word({ evidence: [] })] }), ctx()).dropped).toEqual({ no_valid_evidence: 1 });
  });

  it("drops quotes longer than the configured limit", () => {
    const interests = shippedInterests((raw) => ((raw.limits as Record<string, unknown>).quote_max_chars = 20));
    expect(validateSuggestions(only({ signal_words: [word()] }), ctx({ interests })).accepted).toEqual([]);
  });

  it("drops words below min_confidence and without a reason", () => {
    expect(validateSuggestions(only({ signal_words: [word({ confidence: 0.2 })] }), ctx()).dropped).toEqual({ low_confidence: 1 });
    expect(validateSuggestions(only({ signal_words: [word({ reason_zh: " ", reason_en: "" })] }), ctx()).dropped).toEqual({ missing_reason: 1 });
    const one = validateSuggestions(only({ signal_words: [word({ reason_zh: "", reason_en: "because" })] }), ctx()).accepted[0]?.payload;
    // Only the reasons given are kept, per language
    expect(one).toMatchObject({ reasons: { en: "because" } });
  });

  it("drops what the lists already hold: keyword, benefit tag, or text a pattern already matches", () => {
    expect(validateSuggestions(only({ signal_words: [word({ term: "jobrad" })] }), ctx()).dropped).toEqual({ already_listed: 1 });
    const patternHit = word({ tier: "T2", term: "employee shares", evidence: [{ job_id: 1, quote: "employee shares" }] });
    expect(validateSuggestions(only({ signal_words: [patternHit] }), ctx()).dropped).toEqual({ already_listed: 1 });
  });

  it("follows min_evidence from the config", () => {
    const strict = shippedSuggest((raw) => ((raw.min_evidence as Record<string, number>).signal_word = 3));
    expect(validateSuggestions(only({ signal_words: [word()] }), ctx({ config: strict })).dropped).toEqual({ too_little_evidence: 1 });
    const lenient = shippedSuggest((raw) => ((raw.min_evidence as Record<string, number>).signal_word = 1));
    expect(validateSuggestions(only({ signal_words: [word({ evidence: [{ job_id: 1, quote: "We offer a Wellness budget after three years" }] })] }), ctx({ config: lenient })).accepted).toHaveLength(1);
  });

  it("drops a word that is as common in the ignored jobs as in the liked ones", () => {
    const sameInIgnored = [...ignored.slice(0, 1), sourceJob({ jobId: 13, description: "Wellness budget for all.", applicationStatus: "archived" })];
    const { accepted, dropped } = validateSuggestions(only({ signal_words: [word()] }), ctx({ ignored: sameInIgnored }));
    expect(accepted).toEqual([]);
    expect(dropped).toEqual({ not_distinctive: 1 });
    // without ignored jobs there is nothing to contrast with
    expect(validateSuggestions(only({ signal_words: [word()] }), ctx({ ignored: [] })).accepted).toHaveLength(1);
  });

  it("keeps the more confident of two suggestions for the same word", () => {
    const { accepted, dropped } = validateSuggestions(only({ signal_words: [word({ confidence: 0.6 }), word({ tier: "T4", confidence: 0.9 })] }), ctx());
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.payload).toMatchObject({ tier: "T4", confidence: 0.9 });
    expect(dropped).toEqual({ duplicate: 1 });
  });
});

describe("watched companies", () => {
  const company = (over: Partial<SuggestOutput["companies"][number]> = {}): SuggestOutput["companies"][number] => ({ company: "Northwind Labs", ...reasons, evidence_job_ids: [1, 2], ...over });

  it("accepts a company with liked jobs and stores the name from the database, not the model's spelling", () => {
    const { accepted } = validateSuggestions(only({ companies: [company({ company: "northwind labs gmbh" })] }), ctx());
    expect(accepted[0]?.payload).toMatchObject({ kind: "watched_company", company: "Northwind Labs GmbH" });
    expect(accepted[0]?.payload.evidence.map((e) => e.jobId)).toEqual([1, 2]);
    expect(accepted[0]?.dedupeKey).toBe("watched_company:northwind-labs");
  });

  it("ignores evidence ids of other companies and of ignored jobs", () => {
    const { accepted, dropped } = validateSuggestions(only({ companies: [company({ evidence_job_ids: [3, 11] })] }), ctx());
    expect(accepted).toEqual([]);
    expect(dropped).toEqual({ no_valid_evidence: 1 });
    // one valid job of two cited is "too little" when two are needed
    const strict = shippedSuggest((raw) => ((raw.min_evidence as Record<string, number>).watched_company = 2));
    expect(validateSuggestions(only({ companies: [company({ evidence_job_ids: [1, 3] })] }), ctx({ config: strict })).dropped).toEqual({ too_little_evidence: 1 });
  });

  it("drops companies that are already watched or excluded", () => {
    const interests = shippedInterests((raw) => (raw.watched_companies = ["Northwind Labs"]));
    expect(validateSuggestions(only({ companies: [company()] }), ctx({ interests })).dropped).toEqual({ already_listed: 1 });
    const preferences = { ...context().preferences, exclude_companies: ["Acme AI Inc"] };
    expect(validateSuggestions(only({ companies: [company({ company: "Acme AI", evidence_job_ids: [3] })] }), ctx({ preferences })).dropped).toEqual({ already_listed: 1 });
  });
});

describe("filters", () => {
  const filter = (over: Partial<SuggestOutput["filters"][number]>): SuggestOutput["filters"][number] => ({ action: "exclude_keyword", value: "Cobol", ...reasons, evidence_job_ids: [11, 12], ...over });

  it("accepts an excluded keyword that the ignored jobs contain and no liked job does", () => {
    const { accepted } = validateSuggestions(only({ filters: [filter({})] }), ctx());
    expect(accepted[0]?.payload).toMatchObject({ kind: "filter", action: "exclude_keyword", value: "Cobol" });
    expect(accepted[0]?.dedupeKey).toBe("filter:exclude_keyword:cobol");
  });

  it("refuses a keyword that would also remove a liked job", () => {
    const withCobol = [...liked, sourceJob({ jobId: 5, description: "Some Cobol interop is a plus." })];
    expect(validateSuggestions(only({ filters: [filter({})] }), ctx({ positive: withCobol })).dropped).toEqual({ contradicts_liked: 1 });
  });

  it("needs the keyword to be in the cited ignored jobs", () => {
    expect(validateSuggestions(only({ filters: [filter({ value: "Fortran" })] }), ctx()).dropped).toEqual({ no_valid_evidence: 1 });
    expect(validateSuggestions(only({ filters: [filter({ evidence_job_ids: [1, 2] })] }), ctx()).dropped).toEqual({ no_valid_evidence: 1 });
  });

  it("accepts a city that the liked jobs are in and the preferences lack", () => {
    const hamburg = filter({ action: "add_location", value: "Hamburg", evidence_job_ids: [3, 4] });
    expect(validateSuggestions(only({ filters: [hamburg] }), ctx()).accepted[0]?.payload).toMatchObject({ action: "add_location", value: "Hamburg" });
    expect(validateSuggestions(only({ filters: [filter({ ...hamburg, value: "Berlin" })] }), ctx()).dropped).toEqual({ already_listed: 1 });
    expect(validateSuggestions(only({ filters: [filter({ ...hamburg, value: "Munich" })] }), ctx()).dropped).toEqual({ no_valid_evidence: 1 });
  });

  it("accepts an excluded company whose jobs were ignored, but not one with a liked job", () => {
    const bank = filter({ action: "exclude_company", value: "Legacy Bank" });
    expect(validateSuggestions(only({ filters: [bank] }), ctx()).accepted[0]?.payload).toMatchObject({ action: "exclude_company", value: "Legacy Bank AG" });
    const liking = [...liked, sourceJob({ jobId: 6, companyName: "Legacy Bank", companyNorm: "legacy-bank" })];
    expect(validateSuggestions(only({ filters: [bank] }), ctx({ positive: liking })).dropped).toEqual({ contradicts_liked: 1 });
  });
});
