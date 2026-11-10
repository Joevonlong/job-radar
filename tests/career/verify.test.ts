import { expect, it } from "vitest";
import { verifyCareerField, CAREER_EXTRACT_FLAGS } from "@/lib/career/extract/verify";
import { field, settings } from "./extract-fixtures";

it("verifies quoted years without applying numeric formatting rules to dates", () => {
  expect(verifyCareerField("01/2020", field("2020-01", "01/2020"), settings().evidence, true).flags).toEqual([]);
  expect(verifyCareerField("2021", field("2020", "2021"), settings().evidence, true).flags).toEqual(["year_missing"]);
  expect(verifyCareerField("currently", field("present", "currently"), settings().evidence, true).flags).toEqual([]);
});
it("leaves an invalid date empty and flagged", () => {
  expect(verifyCareerField("2020-13", field("2020-13"), settings().evidence, true)).toMatchObject({ value: "", flags: ["date_invalid"] });
});
it("keeps every verification flag including short quotes and output PII", () => {
  expect(CAREER_EXTRACT_FLAGS).toContain("quote_too_short");
  expect(verifyCareerField("Built x", field("Built things", "x"), settings().evidence).flags).toEqual(["quote_too_short"]);
  expect(verifyCareerField("fell 40%", field("60%", "fell 40%"), settings().evidence).flags).toContain("figure_missing");
  expect(verifyCareerField("source", field("value", "missing"), settings().evidence).flags).toContain("quote_missing");
  expect(verifyCareerField("person@example.test", field("person@example.test"), settings().evidence).flags).toContain("pii");
});
