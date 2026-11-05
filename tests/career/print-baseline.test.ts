// @vitest-environment node
import { expect, test } from "vitest";
import { matchesPrintBaseline } from "../../scripts/career-print-baseline";

test.each([
  { name: "same text and pages", baselineText: "resume", baselinePages: 1, text: "resume", pages: 1, same: true },
  { name: "different text", baselineText: "resume", baselinePages: 1, text: "changed", pages: 1, same: false },
  { name: "different pages", baselineText: "resume", baselinePages: 1, text: "resume", pages: 2, same: false },
  { name: "missing text", baselineText: undefined, baselinePages: 1, text: "resume", pages: 1, same: false },
  { name: "missing page entry", baselineText: "resume", baselinePages: undefined, text: "resume", pages: 1, same: false },
])("baseline comparison: $name", ({ baselineText, baselinePages, text, pages, same }) => {
  expect(matchesPrintBaseline(baselineText, baselinePages, text, pages)).toBe(same);
});
