import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { parseResume } from "../../../../src/lib/career/engine/render";
import { compileLexicon } from "../../../../src/lib/career/engine/compile-lexicon";
import type { CheckLexicon, CheckLimits } from "../../../../src/lib/career/engine";

export const DAY = "2026-10-09";

export function fixture(name: string): string {
  return readFileSync(path.resolve(import.meta.dirname, "../../../fixtures/career", name), "utf8");
}

const Limits = z.strictObject({
  maxMentions: z.number(),
  goodCoverage: z.number(),
  maxBullet: z.number(),
  minBullet: z.number(),
  maxBulletsPerEntry: z.number(),
  maxGapMonths: z.number(),
  proseMinWords: z.number(),
  proseClearWords: z.number(),
  proseRatio: z.number(),
  proseClearRatio: z.number(),
  maxRole: z.number(),
  letterPages: z.number(),
  letterWords: z.strictObject({ min: z.number(), max: z.number() }),
  minPiece: z.number(),
  maxPieces: z.number(),
});
const Language = z.strictObject({
  filler: z.array(z.string()),
  weak: z.array(z.string()),
  proseWords: z.array(z.string()),
  asksSalary: z.array(z.string()),
  asksStart: z.array(z.string()),
  stockOpener: z.array(z.string()),
  level: z.array(z.string()),
  titleStop: z.array(z.string()),
  legal: z.array(z.string()),
  letterLegal: z.array(z.string()),
  roleWord: z.array(z.string()),
  nice: z.array(z.string()),
  requiredHead: z.array(z.string()),
  skipHead: z.array(z.string()),
  tasksHead: z.array(z.string()),
  skipSentence: z.array(z.string()),
  notTech: z.array(z.string()),
  degree: z.strictObject({ words: z.array(z.string()), suffixes: z.array(z.string()) }),
  langContext: z.array(z.string()),
  keywords: z.record(z.string(), z.array(z.string())),
  langs: z.record(z.string(), z.array(z.string())),
  names: z.record(z.string(), z.array(z.string())),
  levelWords: z.strictObject({ native: z.array(z.string()), ranked: z.array(z.strictObject({ rank: z.number(), words: z.array(z.string()) })) }),
});

export const LIMITS: CheckLimits = Limits.parse(parse(fixture("limits.yaml")));
export const LEXICON: CheckLexicon = z.strictObject({ en: Language, de: Language }).parse(parse(fixture("lexicon.yaml")));
export const OPTIONS = { today: DAY, limits: LIMITS, lexicon: LEXICON };
export const COMPILED = compileLexicon(LEXICON);

export function resumeFromYaml(text: string) {
  const result = parseResume(text);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.resume;
}

export function resumeFixture(name: string) {
  return resumeFromYaml(fixture(name));
}

export function issuesOf(text: string) {
  const result = parseResume(text);
  if (result.ok) throw new Error("Expected invalid input");
  return result.issues;
}
