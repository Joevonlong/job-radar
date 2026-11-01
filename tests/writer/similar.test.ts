import { describe, expect, it } from "vitest";

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
  it("finds the companies a text names as whole words, ignoring case and accents", () => {
    expect(mentionedCompanies("I would love to join Acme and its team.", ["Acme", "Initech"])).toEqual(["Acme"]);
    expect(mentionedCompanies("Bei MÜLLER arbeiten", ["Muller"])).toEqual(["Muller"]);
    expect(mentionedCompanies("Acme GmbH is where I learned it", ["Acme GmbH"])).toEqual(["Acme GmbH"]);
  });

  it("does not find a name inside another word, or a name too short to mean anything", () => {
    expect(mentionedCompanies("Acmeville is far away", ["Acme"])).toEqual([]);
    expect(mentionedCompanies("I use a daily", ["A"])).toEqual([]);
    expect(mentionedCompanies("I use X daily", [""])).toEqual([]);
  });

  it("lists each company once", () => {
    expect(mentionedCompanies("Acme, then ACME again", ["Acme", "acme"])).toEqual(["Acme"]);
  });

  it("leaves out this job's own company: reusing an answer for the same company is not out of place", () => {
    const from = [{ company: "Acme" }, { company: "Initech" }];
    expect(staleCompanies("Acme and Initech were great", from, "Acme")).toEqual(["Initech"]);
    expect(staleCompanies("Acme and Initech were great", from, "Globex")).toEqual(["Acme", "Initech"]);
    expect(staleCompanies("A text without names", from, "Globex")).toEqual([]);
  });
});
