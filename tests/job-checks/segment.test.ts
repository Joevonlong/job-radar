// @vitest-environment node
import { describe, expect, it } from "vitest";

import { segmentText } from "@/lib/job-checks/segment";

const texts = (description: string, abbreviations?: readonly string[]): string[] => segmentText(description, abbreviations).map((s) => s.text);

describe("segmentText", () => {
  it("cuts sentences at . ! ? followed by a space", () => {
    expect(texts("We build tools. Do you like it? Join us! Thanks")).toEqual(["We build tools.", "Do you like it?", "Join us!", "Thanks"]);
  });

  it("keeps every segment a verbatim range of the text", () => {
    const description = "  Intro line.\n- First item\n* Second item.  Third sentence.\n\n1. Numbered\n## Heading";
    for (const segment of segmentText(description)) expect(description.slice(segment.start, segment.end)).toBe(segment.text);
  });

  it("makes each list item its own segment, without its marker", () => {
    expect(texts("Benefits\n- Remote work\n• Visa sponsorship\n2) Gym")).toEqual(["Benefits", "Remote work", "Visa sponsorship", "Gym"]);
  });

  it("does not end a sentence at an abbreviation, a single letter or before a lower-case word", () => {
    expect(texts("Tools, e.g. Python and Go. Next one.")).toEqual(["Tools, e.g. Python and Go.", "Next one."]);
    expect(texts("Wir bieten z. B. Visum-Support. Mehr dazu.")).toEqual(["Wir bieten z. B. Visum-Support.", "Mehr dazu."]);
    expect(texts("Laptop etc. and more. End.")).toEqual(["Laptop etc. and more.", "End."]);
  });

  it("uses the caller's abbreviations instead of the defaults", () => {
    expect(texts("See abc. Next.", ["abc"])).toEqual(["See abc. Next."]);
    expect(texts("Tools, e.g. Python.", ["abc"])).toEqual(["Tools, e.g.", "Python."]);
  });

  it("does not cut inside a number or a domain", () => {
    expect(texts("Version 2.5 ships at example.com today. Bye.")).toEqual(["Version 2.5 ships at example.com today.", "Bye."]);
  });

  it("joins a short heading ending in ':' with the first sentence of the next line", () => {
    const description = "Visa sponsorship:\nNot available. Other text.";
    const segments = segmentText(description);
    expect(segments.map((s) => s.text)).toEqual(["Visa sponsorship:\nNot available.", "Other text."]);
    expect(segments[0]?.start).toBe(0);
  });

  it("does not join a heading with a list that follows, nor a long line ending in ':'", () => {
    expect(texts("What we offer:\n- Relocation")).toEqual(["What we offer:", "Relocation"]);
    const long = `${"word ".repeat(15)}ends here:`;
    expect(texts(`${long}\nNext line.`)).toEqual([long, "Next line."]);
  });

  it("returns nothing for an empty or blank text", () => {
    expect(segmentText("")).toEqual([]);
    expect(segmentText("  \n \n")).toEqual([]);
  });
});
