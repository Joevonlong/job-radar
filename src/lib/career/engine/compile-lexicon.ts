import { CareerEngineError } from "./errors";
import { keywordTerms } from "./keywords";
import type { CheckLexicon, LanguageLexicon } from "./lexicon";

function pattern(list: string, entries: string[], before = "", after = "", flags = "i", transform: (entry: string, index: number) => string = (entry) => entry): RegExp {
  const alternatives: string[] = [];
  for (const [index, entry] of entries.entries()) {
    alternatives.push(transform(entry, index));
    try {
      new RegExp(`${before}(?:${alternatives.join("|")})${after}`, flags);
    } catch {
      throw new CareerEngineError("career.lexicon.invalid", { list, entry });
    }
  }
  return new RegExp(`${before}(?:${alternatives.length ? alternatives.join("|") : "(?!)"})${after}`, flags);
}

type ListName = { [K in keyof LanguageLexicon]: LanguageLexicon[K] extends string[] ? K : never }[keyof LanguageLexicon];

export function compileLexicon(data: CheckLexicon) {
  const both = <K extends keyof LanguageLexicon>(key: K) => [data.en[key], data.de[key]];
  const entries = (key: ListName) => [...data.en[key], ...data.de[key]];
  const re = (key: ListName, before = "", after = "", flags = "i") => pattern(key, entries(key), before, after, flags);
  const words = (key: ListName) => re(key, "\\b(", ")\\b");
  const letterBoundary = ["(?<![\\p{L}])(", ")(?![\\p{L}])"] as const;
  const merge = (key: "keywords" | "langs" | "names") => {
    const merged: Record<string, string[]> = {};
    for (const record of both(key)) for (const [term, aliases] of Object.entries(record)) merged[term] = [...(merged[term] ?? []), ...aliases];
    return merged;
  };
  const levels = new Map<number, string[]>();
  for (const rows of both("levelWords")) for (const { rank, words } of rows.ranked) levels.set(rank, [...(levels.get(rank) ?? []), ...words]);
  const native = pattern("levelWords.native", both("levelWords").flatMap((v) => v.native), ...letterBoundary, "iu");
  const ranked = [...levels].map(([rank, entries]) => ({ re: pattern("levelWords.ranked", entries, ...letterBoundary, "iu"), rank }));
  const degrees = [data.en, data.de].flatMap((lang) => [
    ...lang.degree.words.map((entry) => ({ entry, suffix: false })),
    ...lang.degree.suffixes.map((entry) => ({ entry, suffix: true })),
  ]);
  return {
    dict: keywordTerms(merge("keywords")),
    filler: pattern("filler", entries("filler"), "(?<![\\p{L}\\p{N}-])(", ")(?![\\p{L}\\p{N}-])", "giu", (entry) => entry.replace(/~$/, "(e[nmrs]?)?")),
    weak: re("weak", "^(?:(?:I|we|ich|wir)\\s+)?(?:(?:was|were|am|bin|war)\\s+)?(", ")(?![\\p{L}])", "iu"),
    proseWords: { en: new Set(data.en.proseWords), de: new Set(data.de.proseWords) },
    asksSalary: re("asksSalary"),
    asksStart: re("asksStart"),
    stockOpener: re("stockOpener"),
    level: new RegExp(`${re("level", "\\b(", ")\\b", "gi").source}|\\(.*?\\)|[|·•–—]`, "gi"),
    titleStop: new Set(entries("titleStop")),
    legalWord: re("legal", "(?<![\\p{L}\\p{N}])(", ")\\.?(?![\\p{L}\\p{N}])", "iu"),
    legal: re("legal", "^(", ")$", ""),
    letterLegal: re("letterLegal", "\\b(", ")(?=\\s|$)", "gi"),
    roleWord: re("roleWord", "(?<![\\p{L}])(", ")(in)?(?![\\p{L}])", "iu"),
    nice: re("nice", "\\b(", ")"),
    requiredHead: words("requiredHead"),
    skipHead: words("skipHead"),
    tasksHead: words("tasksHead"),
    skipSentence: words("skipSentence"),
    notTech: new Set(entries("notTech")),
    degree: pattern("degree", degrees.map((d) => d.entry), "", "", "iu", (entry, index) => degrees[index].suffix ? `(?<![\\p{L}])\\p{L}*(?:${entry})(?![\\p{L}])` : `(?<![\\p{L}-])(?:${entry})(?![\\p{L}])`),
    langContext: re("langContext"),
    langs: Object.fromEntries(Object.keys(merge("langs")).map((key) => {
      const en = data.en.langs[key] ?? [];
      const de = data.de.langs[key] ?? [];
      return [key, pattern("langs", [...en, ...de], ...letterBoundary, "giu", (entry, index) => index < en.length ? entry : `(?:${entry})(e[nmrs]?)?(kenntnisse|sprachig\\p{L}*)?`)];
    })),
    names: Object.fromEntries(Object.entries(merge("names")).map(([key, entries]) => [key, pattern("names", entries, "^(", ")")])),
    native,
    levelWords: [{ re: native, rank: 6 }, ...ranked],
  };
}

export type CompiledLexicon = ReturnType<typeof compileLexicon>;
