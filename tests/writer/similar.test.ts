import { describe, expect, it } from "vitest";

import { parseConfigText, writerSchema } from "@/lib/config";
import { mentionedCompanies, questionTokens, rankSimilar, similarity, staleCompanies } from "@/lib/writer/similar";

describe("similarity", () => {
  it("is the share of words two questions have in common", () => {
    expect(similarity("Why do you want to work here?", "Why do you want to work here?")).toBe(1);
    expect(similarity("Why do you want to work at Acme?", "Why do you want to work at Initech?")).toBeCloseTo(7 / 9, 5);
    expect(similarity("Describe a challenge solved recently", "Why do you want to work here?")).toBe(0);
  });

  it("ignores case, accents, punctuation and word order", () => {
    expect(similarity("Warum möchten SIE bei uns arbeiten?", "arbeiten bei uns: warum mochten sie")).toBe(1);
    expect(questionTokens("Don't  panic, it's fine!")).toEqual(new Set(["don't", "panic", "it's", "fine"]));
  });

  it("is 0 when either side has no words, and does not match a question in another language", () => {
    expect(similarity("", "Why us?")).toBe(0);
    expect(similarity("???", "Why us?")).toBe(0);
    expect(similarity("Why do you want to join us?", "Warum möchten Sie bei uns arbeiten?")).toBe(0);
  });

  it("counts each Chinese character as a word", () => {
    expect(similarity("你为什么想加入我们", "你为什么想加入我们公司")).toBeGreaterThan(0.8);
    expect(similarity("你为什么想加入我们", "请描述一个挑战")).toBeLessThan(0.2);
  });
});

describe("similarity without the words every question has", () => {
  const stopwords = writerSchema.parse({}).reuse.stopwords;

  it("a question about strengths and one about weaknesses are not alike", () => {
    expect(similarity("What is your greatest strength?", "What is your greatest weakness?")).toBeGreaterThan(0.55);
    expect(similarity("What is your greatest strength?", "What is your greatest weakness?", stopwords)).toBeLessThan(0.55);
    expect(similarity("Was ist Ihre größte Stärke?", "Was ist Ihre größte Schwäche?", stopwords)).toBeLessThan(0.55);
    expect(similarity("你最大的优点是什么", "你最大的缺点是什么", stopwords)).toBeLessThan(0.55);
  });

  it("the same question for another company still matches", () => {
    expect(similarity("Why do you want to work at Acme?", "Why do you want to work at Initech?", stopwords)).toBeGreaterThanOrEqual(0.55);
    expect(similarity("Why do you want to work here?", "Why do you want to work at our company?", stopwords)).toBeGreaterThanOrEqual(0.55);
  });

  it("the company in a question does not count, however many words its name has", () => {
    const candidates = [{ text: "Why do you want to join Windrose Mobility?", company: "Windrose Mobility" }];
    const limits = { minSimilarity: 0.55, maxCandidates: 3, stopwords };
    const question = "Why do you want to join Aurelia Dynamics?";
    expect(rankSimilar(question, candidates, limits)).toEqual([]);
    const ignored = (candidate: { company: string }) => ["Aurelia Dynamics", candidate.company];
    expect(rankSimilar(question, candidates, { ...limits, ignored }).map((entry) => entry.similarity)).toEqual([1]);
    // the questions still have to ask the same thing
    expect(rankSimilar("What do you know about Aurelia Dynamics?", candidates, { ...limits, ignored })).toEqual([]);
  });

  it("questions made only of such words are compared as written", () => {
    expect(similarity("What is it?", "What is it?", stopwords)).toBe(1);
    expect(similarity("What is it?", "Describe a conflict", stopwords)).toBe(0);
  });

  it("rankSimilar leaves the look-alike out, and stopwords are compared like the words of a question", () => {
    const candidates = [{ text: "What is your greatest weakness?" }, { text: "What is your greatest strength, really?" }];
    expect(rankSimilar("What is your greatest strength?", candidates, { minSimilarity: 0.55, maxCandidates: 3, stopwords }).map((entry) => entry.text)).toEqual(["What is your greatest strength, really?"]);
    expect(similarity("WÄS foo bar", "was foo baz", ["Wäs"])).toBeCloseTo(1 / 3, 5);
  });
});

describe("old company names that read like ordinary words", () => {
  const company = (name: string) => ({ company: name, names: [name] });

  it("a short name counts only as written and not as the first word of a sentence", () => {
    expect(mentionedCompanies("It is what it is. IT supports it.", [company("It")])).toEqual([]);
    expect(mentionedCompanies("I would love to join It as an engineer.", [company("It")])).toEqual(["It"]);
    expect(mentionedCompanies("Turn it on. We rely on it.", [company("ON")])).toEqual([]);
    expect(mentionedCompanies("I admire ON for its shoes.", [company("ON")])).toEqual(["ON"]);
    expect(mentionedCompanies("SAP is why I applied.", [company("SAP")])).toEqual(["SAP"]);
  });

  it("the short form without the legal form keeps the case of the stored name", () => {
    const it = { company: "It GmbH", names: ["It GmbH", "it"] };
    expect(mentionedCompanies("It works, and it scales in IT.", [it])).toEqual([]);
    expect(mentionedCompanies("I would love to join It soon.", [it])).toEqual(["It GmbH"]);
  });

  it("a name that is a plain word counts only capitalised", () => {
    expect(mentionedCompanies("We hit our target and used meta tags.", [company("Target"), company("Meta")])).toEqual([]);
    expect(mentionedCompanies("At Target I led it. META hired me. 我在Meta工作", [company("Target"), company("Meta")])).toEqual(["Target", "Meta"]);
  });

  it("a name that is no plain word is still found whatever its case", () => {
    expect(mentionedCompanies("I enjoyed gitlab and ACME LABS.", [company("GitLab"), company("Acme Labs")])).toEqual(["GitLab", "Acme Labs"]);
    expect(mentionedCompanies("Bei Müller und MULLER", [company("Müller")])).toEqual(["Müller"]);
  });
});

describe("rankSimilar", () => {
  const candidates = [
    { id: "newest", text: "Why do you want to work at Initech?" },
    { id: "exact", text: "Why do you want to work at Acme?" },
    { id: "other", text: "Describe a conflict with a colleague" },
    { id: "older-tie", text: "Why do you want to work at Initrode?" },
    { id: "far", text: "Why do you want a job?" },
  ];

  it("keeps the ones at or above the minimum, the most similar first, a tie in the order given, at most the maximum", () => {
    const ranked = rankSimilar("Why do you want to work at Acme?", candidates, { minSimilarity: 0.5, maxCandidates: 3 });
    expect(ranked.map((entry) => entry.id)).toEqual(["exact", "newest", "older-tie"]);
    expect(ranked[0]?.similarity).toBe(1);
  });

  it("offers nothing below the minimum, and a higher minimum drops the weaker ones", () => {
    expect(rankSimilar("Describe your favourite hobby", candidates, { minSimilarity: 0.5, maxCandidates: 3 })).toEqual([]);
    expect(rankSimilar("Why do you want to work at Acme?", candidates, { minSimilarity: 0.9, maxCandidates: 3 }).map((entry) => entry.id)).toEqual(["exact"]);
    expect(rankSimilar("Why do you want to work at Acme?", candidates, { minSimilarity: 0.1, maxCandidates: 0 })).toEqual([]);
  });

  it("the minimum is inclusive", () => {
    const [entry] = rankSimilar("a b c d", [{ text: "a b" }], { minSimilarity: 0.5, maxCandidates: 1 });
    expect(entry?.similarity).toBe(0.5);
  });
});

describe("old company names", () => {
  const co = (company: string, ...extra: string[]) => ({ company, names: [company, ...extra] });

  it("finds the companies a text names as whole words, ignoring case and accents", () => {
    expect(mentionedCompanies("I would love to join Acme and its team.", [co("Acme"), co("Initech")])).toEqual(["Acme"]);
    expect(mentionedCompanies("Bei MÜLLER arbeiten", [co("Muller")])).toEqual(["Muller"]);
    expect(mentionedCompanies("Acme GmbH is where I learned it", [co("Acme GmbH")])).toEqual(["Acme GmbH"]);
    expect(mentionedCompanies("Wir sind die Strasse", [co("Straße")])).toEqual(["Straße"]);
  });

  it("also finds a company by its name without the legal form, and shows the name as stored", () => {
    const acme = co("Acme Inc.", "acme");
    expect(mentionedCompanies("I love Acme", [acme])).toEqual(["Acme Inc."]);
    expect(mentionedCompanies("I love Acme Inc.", [acme])).toEqual(["Acme Inc."]);
    expect(mentionedCompanies("I love Acmeville", [acme])).toEqual([]);
  });

  it("does not find a name inside another word, or a spelling too short to mean anything", () => {
    expect(mentionedCompanies("Acmeville is far away", [co("Acme")])).toEqual([]);
    expect(mentionedCompanies("I use a daily", [co("A")])).toEqual([]);
    expect(mentionedCompanies("I use X daily", [co("")])).toEqual([]);
    // the stored name is too short, its stripped spelling is not
    expect(mentionedCompanies("I love Acme", [co("A", "acme")])).toEqual(["A"]);
  });

  it("lists each company once", () => {
    expect(mentionedCompanies("Acme, then ACME again", [co("Acme"), co("acme")])).toEqual(["Acme"]);
  });

  it("leaves out this job's own company, also when it is spelled with another legal form", () => {
    const from = [co("Acme GmbH", "acme"), co("Initech")];
    expect(staleCompanies("Acme and Initech were great", from, ["Acme GmbH", "acme"])).toEqual(["Initech"]);
    expect(staleCompanies("Acme and Initech were great", from, ["Acme Inc.", "acme"])).toEqual(["Initech"]);
    expect(staleCompanies("Acme and Initech were great", from, ["Globex"])).toEqual(["Acme GmbH", "Initech"]);
    expect(staleCompanies("A text without names", from, ["Globex"])).toEqual([]);
  });
});

describe("the reuse section of writer.yaml", () => {
  it("a file without it loads with the defaults, and a partial one keeps the rest", () => {
    expect(parseConfigText("writer", "config_version: 1\nenabled: true\n").reuse).toEqual({ stopwords: expect.any(Array), min_similarity: expect.any(Number), max_candidates: expect.any(Number), min_question_words: expect.any(Number) });
    const partial = parseConfigText("writer", "config_version: 1\nreuse:\n  max_candidates: 5\n").reuse;
    expect(partial.max_candidates).toBe(5);
    expect(partial.min_similarity).toBe(writerSchema.parse({}).reuse.min_similarity);
    expect(partial.min_question_words).toBe(writerSchema.parse({}).reuse.min_question_words);
  });

  it("rejects values out of range and unknown keys", () => {
    expect(() => parseConfigText("writer", "config_version: 1\nreuse:\n  min_similarity: 1.5\n")).toThrow();
    expect(() => parseConfigText("writer", "config_version: 1\nreuse:\n  min_question_words: 0\n")).toThrow();
    expect(() => parseConfigText("writer", "config_version: 1\nreuse:\n  nope: 1\n")).toThrow();
  });
});
