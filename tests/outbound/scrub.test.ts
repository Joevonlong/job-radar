import { describe, expect, it } from "vitest";
import { prepareScrub, scrubFinal, scrubOutbound } from "@/lib/outbound/scrub";
import { confirmedOutbound, NO_STORED_VALUES, OutboundMismatch, toOutbound } from "@/lib/outbound/outbound";
import { findPii, findPiiSpans } from "@/lib/stories/pii";

const rules = { max_chars: 10000, title_words: ["Lebenslauf", "Curriculum Vitae"], sensitive_labels: ["Geburtsdatum", "Nationality"] };
describe("outbound spans", () => {
  it.each(["01/2020 - 03/2022", "10/2019-12/2023", "2021-03 - 2023-08", "2021-03-2023-08", "12/05/1990", "10 000 000 users", "(2015-2019)", "(03/2021-08/2023)", "2020/21 - 2022/23"])("preserves dates and amounts: %s", (source) => {
    expect(findPiiSpans(source)).toEqual([]);
    expect(scrubOutbound(source, NO_STORED_VALUES).text).toBe(source);
  });
  it.each(["+49 30 1234567", "0151 12345678", "(030) 123456", "030/1234567", "+49 (0)30 123 456", "0049 30 123456", "(0201-1234)"])("still removes actual phones: %s", (source) => {
    expect(findPiiSpans(source)).toEqual([{ kind: "phone", start: 0, end: source.length }]);
    expect(scrubOutbound(source, NO_STORED_VALUES).text).toBe("[phone]");
  });
  it("keeps the existing story warning behavior", () => {
    expect(findPii("(2015-2019)")).toEqual(["phone"]);
    expect(findPii("01/2020 - 03/2022")).toEqual(["phone"]);
    expect(findPii("person@example.test +49 30 1234567")).toEqual(["email", "phone"]);
  });
  it("reports exact email spans and uncertain numbers", () => {
    const source = "Text person@example.test and 123456789";
    const spans = findPiiSpans(source);
    expect(spans.map((span) => [span.kind, source.slice(span.start, span.end)])).toEqual([["email", "person@example.test"], ["maybe_phone", "123456789"]]);
  });
});
it("removes every link form and remains idempotent", () => {
  const source = "https://example.test www.example.test linkedin.com/in/example github.com/example xing.com/profile/example";
  const once = scrubOutbound(source, NO_STORED_VALUES).text;
  expect(once).toBe("[link] [link] [link] [link] [link]");
  expect(scrubOutbound(once, NO_STORED_VALUES).text).toBe(once);
});
it("guesses only a non-title name and replaces its footer occurrences", () => {
  const result = prepareScrub("Lebenslauf\nAlex Example\nSome work\nAlex Example", { stored: NO_STORED_VALUES, rules });
  expect(result.candidates.name).toBe("Alex Example");
  expect(result.text).toBe("Lebenslauf\n[name]\nSome work\n[name]");
  expect(prepareScrub("Curriculum Vitae", { stored: NO_STORED_VALUES, rules }).candidates.name).toBeNull();
});
it("values mode preserves restored phone text and highlights sensitive lines", () => {
  const result = prepareScrub("Alex Example +49 30 1234567\nNationality: sample\n123456789", { stored: NO_STORED_VALUES, rules, name: "Alex Example", mode: "values" });
  expect(result.text).toContain("[name] +49 30 1234567");
  expect(result.highlights.map((span) => result.text.slice(span.start, span.end))).toEqual(expect.arrayContaining(["Nationality: sample", "123456789"]));
});
it("confirmation detects changes and does not reapply phone heuristics", () => {
  expect(() => confirmedOutbound("person@example.test", NO_STORED_VALUES)).toThrow(OutboundMismatch);
  expect(confirmedOutbound("+49 30 1234567", NO_STORED_VALUES)).toBe("+49 30 1234567");
  expect(toOutbound("person@example.test", NO_STORED_VALUES)).toBe("[email]");
  expect(scrubFinal("[email]", { values: [{ value: "email", kind: "name" }] }).text).toBe("[email]");
});
