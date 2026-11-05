// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { CareerEngineError, type CheckLimits, type CheckLexicon, runCheck, runLetterCheck, shipBlockers, pageBudget, exportStem, shownContent } from "../../../src/lib/career/engine";
import { compileLexicon } from "../../../src/lib/career/engine/compile-lexicon";
import { present } from "../../../src/lib/career/engine/extract";
import { parseJd, jdMatch, titleGap, segmentJd } from "../../../src/lib/career/engine/jd";
import { findHits, findTerms } from "../../../src/lib/career/engine/keywords";
import { lint, proseLanguage } from "../../../src/lib/career/engine/lint";
import { lintLetter } from "../../../src/lib/career/engine/letter-check";
import { COMPILED, DAY, LEXICON, LIMITS, OPTIONS, resumeFromYaml, resumeFixture } from "./helpers/fixtures";
import { textPdf } from "./helpers/pdf";
import type { Finding } from "../../../src/lib/career/engine/finding";

const has = (findings: Finding[], code: string) => findings.some((finding) => finding.code === code);
const root = path.resolve(import.meta.dirname, "../../../src/lib/career/engine");

test("threshold and word-list constants have no engine definitions or references", () => {
  const names = "MAX_MENTIONS GOOD_COVERAGE MAX_BULLET MIN_BULLET MAX_BULLETS_PER_ENTRY MAX_GAP_MONTHS MAX_ROLE LETTER_PAGES LETTER_WORDS MIN_PIECE MAX_PIECES DICT KEYWORDS FILLER WEAK EN_WORDS DE_WORDS ASKS_SALARY ASKS_START STOCK_OPENER LEVEL TITLE_STOP LEGAL ROLE_WORD NICE REQUIRED_HEAD SKIP_HEAD TASKS_HEAD SKIP_SENTENCE NOT_TECH DEGREE LANG_CONTEXT LANGS NAMES LEVEL_WORDS".split(" ");
  const source = fs.readdirSync(root, { recursive: true }).filter((file): file is string => typeof file === "string" && file.endsWith(".ts")).map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");
  for (const name of names) expect(source, name).not.toMatch(new RegExp(`\\b${name}\\b`));
});

function requiredInputs() {
  const { maxMentions, ...missingLimit } = LIMITS;
  void maxMentions;
  // @ts-expect-error every limit is required
  const limits: CheckLimits = missingLimit;
  const r = resumeFixture("sample.en.yaml");
  const pdf = textPdf([[r.basics.name]]);
  // @ts-expect-error options are required
  void runCheck(r, pdf);
  // @ts-expect-error the date is required
  void runCheck(r, pdf, { limits, lexicon: LEXICON });
  // @ts-expect-error the lexicon is required
  void runCheck(r, pdf, { today: DAY, limits });
  // @ts-expect-error limits are required
  void runLetterCheck(r, pdf, { today: DAY, lexicon: LEXICON });
  // @ts-expect-error lint requires its lexicon
  void lint(r, { today: DAY, limits });
  // @ts-expect-error a job ad requires limits
  void parseJd("Engineer");
  // @ts-expect-error shown content requires a date
  void shownContent(r);
  // @ts-expect-error export names require a date
  void exportStem(r);
  // @ts-expect-error a language cannot omit a list
  const lexicon: CheckLexicon = { en: { keywords: {} }, de: LEXICON.de };
  return lexicon;
}
void requiredInputs;

test("check limits control required coverage and keyword stuffing", async () => {
  const r = resumeFromYaml('basics: { name: Test, title: Engineer, summary: "Python Python Python Python Python" }');
  const pdf = textPdf([["Test", "Engineer", "Python"]]);
  const jd = parseJd("## Requirements\nPython and Docker", LIMITS);
  const normal = await runCheck(r, pdf, { ...OPTIONS, jd });
  const changed = await runCheck(r, pdf, { ...OPTIONS, jd, limits: { ...LIMITS, maxMentions: 5, goodCoverage: 50 } });
  expect(normal.issues.find((f) => f.code === "career.check.required_coverage")?.level).toBe("warn");
  expect(changed.issues.find((f) => f.code === "career.check.required_coverage")?.level).toBe("ok");
  expect(has(normal.issues, "career.check.stuffing")).toBe(true);
  expect(has(changed.issues, "career.check.stuffing")).toBe(false);
});

test("lint limits control bullet length, number of bullets and experience gaps", () => {
  const r = resumeFromYaml(`basics: { name: Test, title: Engineer }
experience:
  - { company: New, role: Engineer, start: 2020-09, end: present, bullets: ["${"x".repeat(201)}", short] }
  - { company: Old, role: Engineer, start: 2018-01, end: 2019-12 }
`);
  const normal = lint(r, OPTIONS);
  const changed = lint(r, { ...OPTIONS, limits: { ...LIMITS, maxBullet: 202, minBullet: 3, maxBulletsPerEntry: 1, maxGapMonths: 9 } });
  expect(has(normal, "career.lint.bullet_long")).toBe(true);
  expect(has(normal, "career.lint.bullet_short")).toBe(true);
  expect(has(normal, "career.lint.experience_gap")).toBe(true);
  expect(has(changed, "career.lint.bullet_long")).toBe(false);
  expect(has(changed, "career.lint.bullet_short")).toBe(false);
  expect(has(changed, "career.lint.experience_gap")).toBe(false);
  expect(has(changed, "career.lint.bullets_many")).toBe(true);
});

test("each prose-language limit independently controls detection or confidence", () => {
  const text = `${Array(16).fill("the").join(" ")} ${Array(4).fill("und").join(" ")}`;
  expect(proseLanguage(text, LIMITS, COMPILED)).toEqual({ reads: "en", clear: true });
  expect(proseLanguage(text, { ...LIMITS, proseMinWords: 21 }, COMPILED).reads).toBeUndefined();
  expect(proseLanguage(text, { ...LIMITS, proseRatio: 5 }, COMPILED).reads).toBeUndefined();
  expect(proseLanguage(text, { ...LIMITS, proseClearWords: 21 }, COMPILED).clear).toBe(false);
  expect(proseLanguage(text, { ...LIMITS, proseClearRatio: 5 }, COMPILED).clear).toBe(false);
});

test("job-ad, letter and extraction limits are all supplied by the caller", async () => {
  expect(parseJd("1234567890", { ...LIMITS, maxRole: 5 }).role).toBe("12345");
  const r = resumeFixture("letter.de.yaml");
  expect(pageBudget(r, "letter", { ...LIMITS, letterPages: 2 })).toBe(2);
  expect(shipBlockers(r, "letter", { limits: { ...LIMITS, letterPages: 2 }, pages: 2 })).toEqual([]);
  expect((await runLetterCheck(r, textPdf([[r.basics.name], ["extra"]]), { ...OPTIONS, limits: { ...LIMITS, letterPages: 2 } })).issues[0]).toMatchObject({ level: "ok", code: "career.check.pages", params: { pages: 2, budget: 2 } });
  expect(has(lintLetter(r, { ...OPTIONS, limits: { ...LIMITS, letterWords: { min: 10000, max: 20000 } } }), "career.letter.words_short")).toBe(true);
  expect(has(lintLetter(r, { ...OPTIONS, limits: { ...LIMITS, letterWords: { min: 0, max: 1 } } }), "career.letter.words_long")).toBe(true);
  const hay = "abcdefghijklmnop--qrstuvwxyz";
  const needle = "abcdefghijklmnopqrstuvwxyz";
  expect(present(hay, needle, LIMITS)).toBe(true);
  expect(present(hay, needle, { ...LIMITS, maxPieces: 1 })).toBe(false);
  expect(present(hay, needle, { ...LIMITS, minPiece: 17 })).toBe(false);
});

test("lexicon changes affect keywords, filler, letters and job-ad segmentation", () => {
  const lexicon = structuredClone(LEXICON);
  lexicon.en.keywords.Snowflake = ["Snowflake", "SnowSQL"];
  lexicon.en.filler.push("distinctive");
  lexicon.en.stockOpener.push("a\\s+specific\\s+opening");
  lexicon.en.asksSalary.push("pay\\s+wish");
  lexicon.en.requiredHead.push("essentials");
  lexicon.en.nice.push("extras");
  const compiled = compileLexicon(lexicon);
  expect(findTerms("SnowSQL", COMPILED).has("Snowflake")).toBe(false);
  expect(findTerms("SnowSQL", compiled).has("Snowflake")).toBe(true);
  expect(jdMatch(parseJd("Snowflake", LIMITS), "SnowSQL", compiled).required.alias[0]).toMatchObject({ term: "Snowflake", resume: "SnowSQL" });
  const r = resumeFromYaml('basics: { name: Test, title: Engineer, summary: distinctive }\nletter: { body: [a specific opening] }');
  expect(has(lint(r, OPTIONS), "career.lint.filler")).toBe(false);
  expect(lint(r, { ...OPTIONS, lexicon })).toContainEqual({ level: "warn", where: "basics.summary", code: "career.lint.filler", params: { terms: "distinctive" } });
  const jd = parseJd("Send your pay wish", LIMITS);
  expect(has(lintLetter(r, { ...OPTIONS, jd }), "career.letter.salary_missing")).toBe(false);
  const letter = lintLetter(r, { ...OPTIONS, jd, lexicon });
  expect(letter).toContainEqual({ level: "info", where: "letter.body[0]", code: "career.letter.stock_opener", params: { text: "a specific opening" } });
  expect(letter).toContainEqual({ level: "warn", where: "letter.body", code: "career.letter.salary_missing", params: { quote: "pay wish" } });
  expect(segmentJd("## Extras\nPython", COMPILED).required).toBe("Python");
  expect(segmentJd("## Extras\nPython", compiled).nice).toBe("Python");
});

test("both language lists apply, native is explicit, caches are scoped to the lexicon object", () => {
  expect(compileLexicon(LEXICON)).toBe(COMPILED);
  const copy = structuredClone(LEXICON);
  expect(compileLexicon(copy)).not.toBe(COMPILED);
  expect([...findHits("KI and artificial intelligence", COMPILED).keys()]).toEqual(["AI"]);
  expect(titleGap("Backend Engineer", "Senior Backend-Entwickler", COMPILED)).toEqual([]);
  expect(LEXICON.en.levelWords.native).not.toEqual([]);
  expect(LEXICON.de.levelWords.native).not.toEqual([]);
});

test("invalid fragments identify their list and original entry", () => {
  const lexicon = structuredClone(LEXICON);
  lexicon.de.asksStart = ["["];
  expect(() => compileLexicon(lexicon)).toThrow(new CareerEngineError("career.lexicon.invalid", { list: "asksStart", entry: "[" }));
});

test("alias list order preserves reported forms in hits and coverage", () => {
  const text = "domänengetriebenes Design, domain-driven, Systemdesign, architecture";
  expect(findHits(text, COMPILED).get("DDD")?.forms.map((f) => f.text)).toEqual(["domänengetriebenes Design", "domain-driven"]);
  expect(findHits(text, COMPILED).get("system design")?.forms.map((f) => f.text)).toEqual(["Systemdesign", "architecture"]);
  const match = jdMatch(parseJd("DDD and system design", LIMITS), text, COMPILED);
  expect(match.required.alias.map((term) => [term.term, term.resume])).toEqual([["DDD", "domänengetriebenes Design"]]);
});

test.each([
  { list: "asksStart", entries: ["(?<x>a)", "(?<x>b)"], entry: "(?<x>b)" },
  { list: "filler", entries: ["[~"], entry: "[~" },
] as const)("invalid composed fragments retain original $list entries", ({ list, entries, entry }) => {
  const lexicon = structuredClone(LEXICON);
  lexicon.en[list] = [...entries];
  expect(() => compileLexicon(lexicon)).toThrow(new CareerEngineError("career.lexicon.invalid", { list, entry }));
});
