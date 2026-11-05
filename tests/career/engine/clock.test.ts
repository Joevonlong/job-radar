// @vitest-environment node
import { afterEach, expect, test, vi } from "vitest";
import { exportStem, plainLetter, renderResume, runCheck, runLetterCheck, shownContent } from "../../../src/lib/career/engine";
import { lint } from "../../../src/lib/career/engine/lint";
import { DAY, OPTIONS, resumeFromYaml, resumeFixture } from "./helpers/fixtures";
import { textPdf } from "./helpers/pdf";
import { imagePng } from "./helpers/images";

afterEach(() => vi.useRealTimers());

test("all date-sensitive engine APIs ignore the system clock", async () => {
  const r = resumeFixture("letter.de.yaml");
  r.meta.signature = { date: "auto" };
  r.letter!.date = undefined;
  r.meta.filename = "{name}_{date}";
  r.basics.summary = "Engineer with 4 years in software.";
  r.experience = [{ company: "Example", role: "Engineer", start: "2020-01", end: "present", bullets: [], stack: [] }];
  const opts = { ...OPTIONS, images: { signature: imagePng() } };
  const pdf = textPdf([[r.basics.name, "Engineer"]]);
  const values = async () => ({
    resume: renderResume(r, { today: DAY }),
    letter: renderResume(r, { today: DAY, doc: "letter" }),
    check: await runCheck(r, pdf, opts),
    letterCheck: await runLetterCheck(r, pdf, opts),
    lint: lint(r, opts),
    shown: shownContent(r, DAY),
    plain: plainLetter(r, DAY),
    stem: exportStem(r, DAY),
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2001-01-01"));
  const first = await values();
  vi.setSystemTime(new Date("2040-12-31"));
  expect(await values()).toEqual(first);
});

test("a different supplied day changes automatic dates, names and present experience totals", () => {
  const r = resumeFromYaml('meta: { signature: { date: auto }, filename: "{name}_{date}" }\nbasics: { name: Test, title: Engineer, summary: "4 years in software." }\nexperience: [{ company: Example, role: Engineer, start: 2020-01, end: present }]\nletter: { body: [Hello] }');
  const early = "2024-01-01";
  const late = "2028-12-31";
  expect(renderResume(r, { today: early })).not.toBe(renderResume(r, { today: late }));
  expect(renderResume(r, { today: early, doc: "letter" })).not.toBe(renderResume(r, { today: late, doc: "letter" }));
  expect(shownContent(r, early)).not.toEqual(shownContent(r, late));
  expect(plainLetter(r, early)).not.toBe(plainLetter(r, late));
  expect(exportStem(r, early)).not.toBe(exportStem(r, late));
  expect(lint(r, { ...OPTIONS, today: early }).some((i) => i.code === "career.lint.years_stale")).toBe(false);
  expect(lint(r, { ...OPTIONS, today: late })).toContainEqual(expect.objectContaining({ code: "career.lint.years_stale", params: { text: "4 years", years: 9 } }));
});
