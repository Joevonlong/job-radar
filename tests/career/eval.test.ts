// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

import { SAMPLE_ROOT, samplePath, scoreExtraction } from "../../scripts/career-extract-eval";
import { output, field } from "./extract-fixtures";
import { extractText } from "../../src/lib/career/engine/extract";

it("scores each field, counting duplicates, missing facts and unsupported facts", () => {
  const expected = output();
  const actual = output();
  actual.experience[0]!.role = field("Manager");
  actual.experience[0]!.start = null;
  actual.experience[0]!.bullets.push(field("Built a service"), field("Invented result"));
  const scores = scoreExtraction(expected, actual);
  expect(scores["experience.company"]).toEqual({ truePositive: 1, falsePositive: 0, falseNegative: 0, precision: 1, recall: 1 });
  expect(scores["experience.role"]).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 1, precision: 0, recall: 0 });
  expect(scores["experience.start"]).toMatchObject({ precision: null, recall: 0, falseNegative: 1 });
  expect(scores["experience.bullets"]).toMatchObject({ truePositive: 1, falsePositive: 2, falseNegative: 0, precision: 1 / 3, recall: 1 });
});
it("ignores entry order and whitespace while keeping punctuation significant", () => {
  const expected = output({ skills: [{ group: "Code", items: [field("C++"), field("C#")] }] });
  const actual = output({ skills: [{ group: "code", items: [field(" C# "), field("C++")] }] });
  expect(Object.values(scoreExtraction(expected, actual)).every((score) => score.precision === 1 && score.recall === 1)).toBe(true);
  actual.skills[0]!.items = [field("C")];
  expect(scoreExtraction(expected, actual)["skills.items"]).toMatchObject({ truePositive: 0, falsePositive: 1, falseNegative: 2 });
});
it("refuses outside sources, path traversal and symlinks before provider creation", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "career-eval-"));
  const link = path.join(SAMPLE_ROOT, "outside-fixture.txt");
  try {
    const outside = path.join(directory, "source.txt"); fs.writeFileSync(outside, "fictional");
    expect(() => samplePath(outside)).toThrow("sample_only");
    expect(() => samplePath(path.join(SAMPLE_ROOT, "../profile.yaml"))).toThrow("sample_only");
    fs.symlinkSync(outside, link);
    expect(() => samplePath(link)).toThrow("sample_only");
  } finally { fs.rmSync(link, { force: true }); fs.rmSync(directory, { recursive: true, force: true }); }
});
it("dry-runs every fictional text, Markdown and PDF through the real prompt, router, parser and verifier", () => {
  const log = execFileSync(process.execPath, ["--import", "tsx", "scripts/career-extract-eval.ts", "--dry"], { encoding: "utf8", timeout: 60_000 });
  const lines = log.trim().split("\n").map((line) => JSON.parse(line));
  expect(lines[0]).toMatchObject({ mode: "dry_scripted_expected_answers", samples: 10, modelQualityMeasured: false });
  expect(lines.filter((line) => line.sample)).toHaveLength(10);
  expect(lines.every((line) => !line.error)).toBe(true);
  expect(lines.filter((line) => line.sample).every((line) => Object.keys(line.flags).length === 0)).toBe(true);
  expect(lines.at(-1).total["experience.company"]).toMatchObject({ truePositive: 30, precision: 1, recall: 1 });
});
it("does not reward roles and dates assigned to the wrong company", () => {
  const first = output().experience[0]!;
  const second = { ...first, company: field("Other Fictional Company"), role: field("Designer"), start: field("2024") };
  const expected = output({ experience: [first, second] });
  const actual = output({ experience: [{ ...first, role: second.role, start: second.start }, { ...second, role: first.role, start: first.start }] });
  expect(scoreExtraction(expected, actual)["experience.company"]).toMatchObject({ truePositive: 2, precision: 1, recall: 1 });
  expect(scoreExtraction(expected, actual)["experience.role"]).toMatchObject({ truePositive: 0, falsePositive: 2, falseNegative: 2 });
  expect(scoreExtraction(expected, actual)["experience.start"]).toMatchObject({ truePositive: 0, falsePositive: 2, falseNegative: 2 });
});

it.each(["promotion", "rehire", "overlap"])("matches %s experiences at one company one-to-one", (scenario) => {
  const first = { ...output().experience[0]!, end: field(scenario === "overlap" ? "2025" : "2022") };
  const second = { ...first, role: field(scenario === "rehire" ? "Engineer" : "Lead"),
    start: field(scenario === "promotion" ? "2022" : "2024"), end: null, bullets: [field("Led a team")] };
  const expected = output({ experience: [first, second] });
  const actual = output({ experience: [
    { ...first, start: second.start, bullets: second.bullets },
    { ...second, start: first.start, bullets: first.bullets },
  ] });
  if (scenario === "rehire") {
    actual.experience[0]!.bullets = first.bullets;
    actual.experience[1]!.bullets = second.bullets;
  }
  const scores = scoreExtraction(expected, actual);
  expect(Object.values(scores).every((score) => score.precision === 1 && score.recall === 1)).toBe(false);
  const reordered = output({ experience: [second, first] });
  expect(Object.values(scoreExtraction(expected, reordered)).every((score) => score.precision === 1 && score.recall === 1)).toBe(true);
});


it.each(["de-publications.pdf", "de-two-column.pdf"])("preserves German characters in %s text", async (file) => {
  const text = await extractText(new Uint8Array(fs.readFileSync(path.join(SAMPLE_ROOT, file))));
  expect(text).toContain("für");
  expect(text).toContain("Übergabe");
  expect(text).toContain("regelmäß");
});
