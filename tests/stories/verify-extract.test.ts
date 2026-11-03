import { describe, expect, it } from "vitest";

import { writerSchema } from "@/lib/config/schemas/writer";
import { countFlags, draftToStory } from "@/lib/stories/extract";
import { verifyExtractedDraft, verifyExtractField, type ExtractedDraft } from "@/lib/stories/verify-extract";

const SOURCE = `Moved the billing service to the new platform.\nErrors fell by 40% in the first   quarter.\nUsed Go and PostgreSQL. 2021-2023.`;
const config = { ...writerSchema.parse({}).evidence, min_quote_chars: 4 };
const limits = { titleMaxChars: 30, textMaxChars: 100, listMaxItems: 2 };
const field = (value: string, quote: string) => ({ value, quote });

describe("the check of one extracted field", () => {
  it("flags a Latin magnitude or multiple the quote does not have", () => {
    const source = "Saved the team a lot of money every year.";
    for (const value of ["Saved $2M a year", "Saved $5B", "Saved 2.5M", "10x cheaper"]) {
      expect(verifyExtractField(source, field(value, "Saved the team a lot of money"), config).flag).toBe("figure_missing");
    }
    expect(verifyExtractField("Saved 2,000,000 dollars.", field("Saved $2M", "Saved 2,000,000 dollars"), config).flag).toBeNull();
  });

  it("passes a value whose quote is in the source, and stores the source's own text", () => {
    expect(verifyExtractField(SOURCE, field("Errors fell by 40%", "Errors fell by 40% in the first quarter."), config)).toEqual({
      value: "Errors fell by 40%",
      quote: "Errors fell by 40% in the first   quarter.",
      flag: null,
      missing: [],
    });
  });

  it("flags a quote that is not in the source", () => {
    expect(verifyExtractField(SOURCE, field("Led a team of ten", "led a team of ten"), config).flag).toBe("quote_missing");
    expect(verifyExtractField(SOURCE, field("Moved billing", ""), config).flag).toBe("quote_missing");
  });

  it("flags an invented figure although its quote exists: 60% against a source that says 40%", () => {
    const checked = verifyExtractField(SOURCE, field("Errors fell by 60%", "Errors fell by 40%"), config);
    expect(checked.flag).toBe("figure_missing");
    expect(checked.missing).toEqual(["60%"]);
  });

  it("flags a quote too short to back anything, unless it is the value itself", () => {
    expect(verifyExtractField(SOURCE, field("Wrote the billing service in Go", "Go"), config).flag).toBe("quote_too_short");
    expect(verifyExtractField(SOURCE, field("Go", "Go"), config).flag).toBeNull();
  });
});

describe("the stored form of a draft", () => {
  const draft: ExtractedDraft = {
    title: field("Moved billing", "Moved the billing service"),
    what: field("Moved the service", "Moved the billing service to the new platform."),
    result: field("Errors fell by 60%", "Errors fell by 40%"),
    period: field("2021-2023", "2021-2023"),
    metrics: [field("40% fewer errors", "not in there"), field("40% FEWER errors", "not in there"), field(" ", "x")],
    skills: [field("Go", "Go"), field("PostgreSQL", "PostgreSQL"), field("Rust", "Rust")],
    language: "EN",
  };

  it("checks every field, drops repeats and empties, and counts the flags", () => {
    const stored = verifyExtractedDraft(SOURCE, draft, config, limits);
    expect(stored.metrics).toHaveLength(1);
    expect(stored.skills.map((skill) => skill.value)).toEqual(["Go", "PostgreSQL"]);
    expect(stored.language).toBe("en");
    expect(countFlags(stored)).toBe(2);
  });

  it("cuts values to what a story may hold, so that a draft can always be adopted", () => {
    const stored = verifyExtractedDraft(SOURCE, { ...draft, title: field("x".repeat(90), "Moved"), what: field("y".repeat(900), "Moved") }, config, limits);
    expect(stored.title.value).toHaveLength(30);
    expect(stored.what.value).toHaveLength(100);
  });

  it("drops an unusable language code rather than block the story", () => {
    expect(verifyExtractedDraft(SOURCE, { ...draft, language: "english" }, config, limits).language).toBeNull();
  });

  it("becomes a story without an id, whose source is the draft's origin", () => {
    const story = draftToStory(verifyExtractedDraft(SOURCE, draft, config, limits), "resume");
    expect(story).toMatchObject({ id: "", source: "resume", title: "Moved billing", result: "Errors fell by 60%", period: "2021-2023", tags: [] });
  });
});
