// @vitest-environment node
import { describe, expect, it } from "vitest";

import { searchSettings } from "../fixtures/job-search";

import { buildCountryLexicon, normalizeSearchText, parseSearchQuery } from "@/lib/jobs/search-query";

const countries = [
  { code: "DE", name: "Germany", aliases: ["Deutschland"] },
  { code: "US", name: "United States" },
  { code: "IT", name: "Italy" },
  { code: "IN", name: "India" },
  { code: "AT", name: "Austria" },
  { code: "FR", name: "France" },
  { code: "ES", name: "Spain" },
  { code: "AI", name: "Anguilla" },
  { code: "JE", name: "Jersey", match: false },
];
const options = { locales: ["en", "de", "zh"], ambiguousCodes: ["AI", "AT", "IN", "IS", "IT", "US"], extraAliases: { DE: ["Federal Republic of Germany"] } };
const lexicon = buildCountryLexicon(countries, options);
const settings = { ranking: searchSettings.ranking, maxTerms: 12, prefixMinChars: 4, cjkMinChars: 2, maxChars: 200, allScopeTimeoutMs: 8000 };
const context = {
  lexicon,
  cityAliases: { Munich: ["München", "Muenchen"], "New York": ["NYC"] },
  transliterations: { ü: "ue" },
  settings,
};
const parse = (q: string | null | undefined) => parseSearchQuery(q, context);

describe("search query terms", () => {
  it("keeps short Latin words whole and longer ones as prefixes", () => {
    expect(parse("AI").terms).toEqual([expect.objectContaining({ text: "ai", kind: "word", match: "whole", words: ["ai"], countryCodes: [] })]);
    expect(parse("ai-driven").terms).toEqual([
      expect.objectContaining({ text: "ai", match: "whole" }),
      expect.objectContaining({ text: "driven", match: "prefix" }),
    ]);
  });

  it("splits Latin and CJK runs and retains sufficiently long CJK fragments", () => {
    expect(parse("AI工程师")).toMatchObject({ status: "ok", hasCjk: true, terms: [
      { text: "ai", kind: "word", match: "whole" },
      { text: "工程师", kind: "cjk", match: "literal" },
    ] });
    expect(parse("ai德")).toMatchObject({ hasCjk: false, terms: [{ text: "ai" }] });
  });

  it("preserves attached programming-language symbols", () => {
    const terms = parse("C++ C# .NET node.js").terms;
    expect(terms.map((term) => term.text)).toEqual(["c++", "c#", ".net", "node.js"]);
    for (const term of terms) expect(term).toMatchObject({ kind: "symbol", match: "literal", countryCodes: [], words: [term.text] });
    expect(parse("#DE +C").terms).toMatchObject([
      { text: "#de", kind: "symbol", match: "literal", countryCodes: [] },
      { text: "+c", kind: "symbol", match: "literal", countryCodes: [] },
    ]);
  });

  it("splits punctuation, strips sentence dots and retains internal dots", () => {
    expect(parse("(berlin.),ai/driven, .NET. node.js.").terms.map((term) => term.text)).toEqual(["berlin", "ai", "driven", ".net", "node.js"]);
  });

  it("keeps quoted words ordered in a whole phrase, including an unclosed quote", () => {
    expect(parse('"Product Manager" Berlin').terms).toMatchObject([
      { text: "product manager", kind: "phrase", match: "whole", words: ["product", "manager"] },
      { text: "berlin", kind: "word", match: "prefix", words: ["berlin"] },
    ]);
    expect(parse('"product manager').terms).toMatchObject([{ kind: "phrase", words: ["product", "manager"] }]);
  });

  it("includes CJK runs as ordered phrase words without erasing short runs", () => {
    expect(parse('"AI工程师 manager"')).toMatchObject({ hasCjk: true, terms: [{ kind: "phrase", words: ["ai", "工程师", "manager"] }] });
    expect(parse('"product德manager"').terms[0]?.words).toEqual(["product", "德", "manager"]);
  });

  it.each(["%", "+++", '""', '"  "', "德", ".", "#"])("returns no_terms for %s", (q) => {
    expect(parse(q)).toEqual({ status: "no_terms", terms: [], droppedTerms: 0, hasCjk: false, phrase: null, ranking: settings.ranking, allScopeTimeoutMs: 8000 });
  });

  it.each([null, undefined, "", " \t\n "])("returns none for empty input %s", (q) => {
    expect(parse(q)).toEqual({ status: "none", terms: [], droppedTerms: 0, hasCjk: false, phrase: null, ranking: settings.ranking, allScopeTimeoutMs: 8000 });
  });

  it("deduplicates terms before applying the limit", () => {
    expect(parse("AI ai ＡＩ").terms.map((term) => term.text)).toEqual(["ai"]);
    const words = "one two three four five six seven eight nine ten eleven twelve thirteen";
    expect(parse(words)).toMatchObject({ droppedTerms: 1, terms: Array.from({ length: 12 }, () => expect.objectContaining({ kind: "word" })) });
    expect(parse(`${words} one`).droppedTerms).toBe(1);
  });

  it("reports CJK only when retained and counts only distinct terms beyond the cap as dropped", () => {
    expect(parseSearchQuery("ai ai 德 工程师", { ...context, settings: { ...settings, maxTerms: 1 } })).toMatchObject({ terms: [{ text: "ai" }], droppedTerms: 1, hasCjk: false });
  });

  it("builds the full-query phrase from the words of at least two kept terms", () => {
    expect(parse('"Product Manager" Berlin AI').phrase).toBe("product manager berlin ai");
    expect(parse("United States Berlin").phrase).toBe("united states berlin");
    expect(parse('"Product Manager"').phrase).toBeNull();
    expect(parse("AI AI").phrase).toBeNull();
  });

  it("normalizes full-width letters and combining accents without folding accents away", () => {
    expect(parse("ＡＩ")).toEqual(parse("ai"));
    expect(parse("Ａｉｒｂｕｓ")).toEqual(parse("airbus"));
    expect(parse("Me\u0301xico")).toEqual(parse("México"));
    expect(normalizeSearchText("Me\u0301xico")).toBe("méxico");
  });

  it("carries supplied ranking and keeps single quoted words whole", () => {
    expect(parse("AI").ranking).toEqual(settings.ranking);
    expect(parse('"Engineer"').terms[0]?.match).toBe("whole");
  });

  it("cuts the input before normalization and tokenization", () => {
    expect(parseSearchQuery("ＡＩ Berlin", { ...context, settings: { ...settings, maxChars: 2 } })).toEqual(parse("ai"));
    expect(parseSearchQuery("ﬃ Berlin", { ...context, settings: { ...settings, maxChars: 1 } }).terms[0]?.text).toBe("ffi");
  });
});

describe("country recognition", () => {
  it.each(["Germany", "deutschland", "德国"])("recognizes %s as a country name while retaining text matching", (q) => {
    expect(parse(q).terms).toMatchObject([{ countryCodes: ["DE"], countryOnly: false }]);
  });

  it.each(["DE", "de"])("recognizes %s only as a country code", (q) => {
    expect(parse(q).terms).toMatchObject([{ countryCodes: ["DE"], countryOnly: true }]);
  });

  it("keeps lowercase or mixed-case codes as text in longer queries and capitals as countries", () => {
    expect(parse("Chef de projet").terms).toMatchObject([
      { text: "chef", countryCodes: [] }, { text: "de", kind: "word", match: "whole", countryCodes: [], countryOnly: false }, { text: "projet", countryCodes: [] },
    ]);
    expect(parse("ingeniero de software ES").terms).toMatchObject([
      { text: "ingeniero", countryCodes: [] }, { text: "de", countryCodes: [] }, { text: "software", countryCodes: [] },
      { text: "es", countryCodes: ["ES"], countryOnly: true },
    ]);
    expect(parse("engineer DE").terms).toMatchObject([{ text: "engineer", countryCodes: [] }, { text: "de", countryCodes: ["DE"], countryOnly: true }]);
    expect(parse("engineer De").terms[1]).toMatchObject({ text: "de", countryCodes: [] });
    expect(parse("ＤＥ engineer").terms[0]).toMatchObject({ text: "de", countryCodes: ["DE"] });
    expect(parse('"engineer" de').terms[1]).toMatchObject({ text: "de", countryCodes: [] });
    expect(parse("engineer germany").terms[1]).toMatchObject({ countryCodes: ["DE"], countryOnly: false });
    expect(parse("engineer IT").terms[1]?.countryCodes).toEqual([]);
  });

  it("never treats quoted words as countries, including single words and symbols", () => {
    expect(parse('"de"').terms).toMatchObject([{ text: "de", kind: "word", countryCodes: [], countryOnly: false }]);
    expect(parse('"Germany"').terms[0]?.countryCodes).toEqual([]);
    expect(parse('"United States"').terms[0]?.countryCodes).toEqual([]);
    expect(parse('"C++"').terms[0]).toMatchObject({ kind: "symbol", match: "literal", countryCodes: [] });
  });

  it("uses the longest unquoted name match", () => {
    expect(parse("United States").terms).toMatchObject([{ text: "united states", kind: "phrase", words: ["united", "states"], match: "whole", countryCodes: ["US"], countryOnly: false }]);
    expect(parse("Federal Republic of Germany").terms).toMatchObject([{ countryCodes: ["DE"] }]);
    const overlap = buildCountryLexicon([{ code: "US", name: "United" }, { code: "DE", name: "United States" }], { ...options, locales: [] });
    expect(parseSearchQuery("United States", { ...context, lexicon: overlap }).terms).toMatchObject([{ countryCodes: ["DE"] }]);
    expect(parse('United "States"').terms).toHaveLength(2);
    expect(parse("United C++ States").terms).toHaveLength(3);
  });

  it.each(["IT", "in", "AT", "AI", "US", "Jersey", "JE"])("does not recognize %s as a free-text country", (q) => {
    expect(parse(q).terms[0]?.countryCodes).toEqual([]);
  });

  it("still recognizes the names of countries with ambiguous bare codes", () => {
    expect(parse("Italy").terms[0]?.countryCodes).toEqual(["IT"]);
    expect(parse("India").terms[0]?.countryCodes).toEqual(["IN"]);
    expect(lexicon.entries.has("it")).toBe(false);
    expect(lexicon.namesByCode.get("JE")).toContain("jersey");
    expect(lexicon.entries.has("jersey")).toBe(false);
    expect(lexicon.entries.has("je")).toBe(false);
    expect(lexicon.maxWords).toBeGreaterThanOrEqual(4);
  });

  it("retains every country for colliding names and prefers names over bare codes", () => {
    const shared = buildCountryLexicon([
      { code: "DE", name: "Shared", aliases: ["FR", "C++", "Me\u0301xico"] },
      { code: "FR", name: "Shared" },
    ], { ...options, locales: [], extraAliases: {} });
    const query = (q: string) => parseSearchQuery(q, { ...context, lexicon: shared });
    expect(query("shared").terms[0]?.countryCodes).toEqual(["DE", "FR"]);
    expect(query("fr").terms[0]).toMatchObject({ countryCodes: ["DE"], countryOnly: false });
    expect(query("C++").terms[0]?.countryCodes).toEqual([]);
    expect(query("México").terms[0]?.countryCodes).toEqual(["DE"]);
  });

  it("skips unsupported locales and display names that just repeat the code", () => {
    const unknown = buildCountryLexicon([{ code: "XX", name: "Unknown region" }], { locales: ["bad_locale", "en"], ambiguousCodes: [], extraAliases: {} });
    expect(unknown.namesByCode.get("XX")).toEqual(["unknown region"]);
    expect(unknown.entries.get("xx")).toEqual([{ code: "XX", source: "code" }]);
  });
});

describe("location variants", () => {
  it("expands a city group per term and keeps the normalized input first", () => {
    expect(parse("AI München").terms).toMatchObject([
      { text: "ai", locationVariants: ["ai"] },
      { text: "münchen", locationVariants: ["münchen", "munich", "muenchen"] },
    ]);
    expect(parse("Muenchen").terms[0]?.locationVariants).toEqual(["muenchen", "munich", "münchen"]);
    expect(parse('"New York"').terms[0]?.locationVariants).toEqual(["new york", "nyc"]);
  });
});
