// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { expect, expectTypeOf, it } from "vitest";
import type { CheckLimits, CheckLexicon } from "@/lib/career/engine";
import { careerSchema, careerCheckLimitsSchema, careerCheckLexiconSchema } from "@/lib/config/schemas/career";
import { mergeLayers } from "@/lib/config/merge";
import { replaceRule, recordKindAt } from "@/lib/config/overlay-rules";
import { HIDDEN_PATHS } from "@/lib/settings/fields";
import { checkWithoutPdf, checkWithPdf } from "@/lib/career/render/check";
import { uncoveredCharacters } from "@/lib/career/render/fonts-coverage";
import { toResume } from "@/lib/career/render/to-resume";
import { emptyContact } from "@/lib/career/schema/contact";
import { document } from "./document-fixtures";
import { LEXICON, LIMITS } from "./engine/helpers/fixtures";
import { textPdf } from "./engine/helpers/pdf";

const check = careerSchema.parse({ check: { limits: LIMITS, lexicon: LEXICON } }).check;
const options = { today: "2026-11-01", check, doc: "resume" as const };

it("keeps config shapes aligned with engine types and parses shipped settings", () => {
  expectTypeOf<ReturnType<typeof careerCheckLimitsSchema.parse>>().toEqualTypeOf<CheckLimits>();
  expectTypeOf<ReturnType<typeof careerCheckLexiconSchema.parse>>().toEqualTypeOf<CheckLexicon>();
  const raw = parse(fs.readFileSync(path.resolve("config/career.yaml"), "utf8")) as Record<string, unknown>;
  delete raw.config_version;
  const configured = careerSchema.parse(raw).check;
  expectTypeOf(configured.limits).toEqualTypeOf<CheckLimits>();
  expect(careerCheckLexiconSchema.safeParse(configured.lexicon).success).toBe(true);
  expect(HIDDEN_PATHS.career).toContain("check");
});

it("changes live lint results when limits and lexicon change without PDF-only findings", () => {
  const doc = document();
  doc.experience[0]!.bullets[0]!.text = "Unusualword built a dependable service";
  const { resume } = toResume(doc, emptyContact(), {}, "resume");
  const loose = checkWithoutPdf(resume, options);
  const strict = checkWithoutPdf(resume, { ...options, check: { ...check,
    limits: { ...check.limits, maxBullet: 5 },
    lexicon: { ...check.lexicon, en: { ...check.lexicon.en, filler: ["Unusualword"] } },
  } });
  expect(loose.some((item) => item.code === "career.lint.filler")).toBe(false);
  expect(strict).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "career.lint.filler", params: { terms: "unusualword" } }),
    expect.objectContaining({ code: "career.lint.bullet_long" }),
  ]));
  expect(strict.some((item) => /pages|order|parser/.test(item.code))).toBe(false);
  expect(strict.every((item) => Object.keys(item).every((key) => ["code", "params", "severity", "path"].includes(key))))
    .toBe(true);
});

it.each(["resume", "letter"] as const)("surfaces placeholders and gates for %s", (doc) => {
  const draft = document();
  draft.headline!.text = "TODO";
  draft.letter = { recipient: [], place: null, date: null, subject: null, salutation: null, closing: null,
    body: [{ id: "", text: "TODO", origin: "user", source: null }] };
  const { resume } = toResume(draft, emptyContact(), {}, doc);
  const result = checkWithoutPdf(resume, { ...options, doc });
  expect(result).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "career.lint.placeholder", severity: "error" }),
    expect.objectContaining({ code: "career.gate.placeholders" }),
  ]));
});

it.each(["resume", "letter"] as const)("adds page budget, reading order and parser checks for %s", async (doc) => {
  const draft = document();
  draft.layout.pages = 1;
  draft.letter = { recipient: [], place: null, date: null, subject: null, salutation: null, closing: null,
    body: [{ id: "", text: "A short letter", origin: "user", source: null }] };
  const { resume } = toResume(draft, emptyContact(), {}, doc);
  const result = await checkWithPdf(resume, textPdf([[], []]), { ...options, doc });
  expect(result).toMatchObject({ pages: 2, budget: { pages: 1, exceeded: true } });
  expect(result.findings).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: "career.check.pages" }),
    expect.objectContaining({ path: "reading_order" }),
    expect.objectContaining({ code: "career.gate.pages" }),
  ]));
});

it("merges added dictionary entries while untouched shipped lists continue updating", () => {
  expect(recordKindAt("career", ["check", "lexicon", "en", "keywords"])).toBe("entries");
  const base = { check: { lexicon: { en: { keywords: { Python: ["Python"] }, filler: ["old"] } } } };
  const overlay = { check: { lexicon: { en: { keywords: { Example: ["Example"] } } } } };
  const updated = structuredClone(base);
  updated.check.lexicon.en.keywords.Python.push("CPython");
  updated.check.lexicon.en.filler = ["new"];
  expect(mergeLayers(updated, overlay, { replaceAt: replaceRule("career") })).toMatchObject({
    check: { lexicon: { en: { keywords: { Python: ["Python", "CPython"], Example: ["Example"] }, filler: ["new"] } } },
  });
});

it("reports uncovered Chinese characters, deduplicates and caps by code point", () => {
  expect(uncoveredCharacters("Résumé für Größe ÄÖÜäöüß café Latin", 32)).toEqual([]);
  expect(uncoveredCharacters("中文中😀文汉", 3)).toEqual(["中", "文", "😀"]);
});
