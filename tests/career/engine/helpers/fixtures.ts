import { readFileSync } from "node:fs";
import path from "node:path";
import { parseResume } from "../../../../src/lib/career/engine/render";
import { compileLexicon } from "../../../../src/lib/career/engine/compile-lexicon";
import { checkOptions } from "./check-options";

export const DAY = "2026-10-09";

export function fixture(name: string): string {
  return readFileSync(path.resolve(import.meta.dirname, "../../../fixtures/career", name), "utf8");
}

export const { limits: LIMITS, lexicon: LEXICON } = checkOptions(path.resolve(import.meta.dirname, "../../../fixtures/career"));
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
