// @vitest-environment node
import { describe, expect, it } from "vitest";

import { segmentText, type SegmentOptions } from "@/lib/job-checks/segment";

const HEADING = 60;
const cut = (description: string, options: Partial<SegmentOptions> = {}) => segmentText(description, { headingMaxChars: HEADING, ...options });
const texts = (description: string, abbreviations?: readonly string[]): string[] => cut(description, { abbreviations }).map((s) => s.text);

describe("segmentText", () => {
  it("cuts sentences at . ! ? followed by a space", () => {
    expect(texts("We build tools. Do you like it? Join us! Thanks")).toEqual(["We build tools.", "Do you like it?", "Join us!", "Thanks"]);
  });

  it("keeps every segment a verbatim range of the text", () => {
    const description = "  Intro line.\n- First item\n* Second item.  Third sentence.\n\n1. Numbered\n## Heading";
    for (const segment of cut(description)) expect(description.slice(segment.start, segment.end)).toBe(segment.text);
  });

  it("makes each list item its own segment, without its marker, and marks it as a list item", () => {
    const segments = cut("Benefits\n- Remote work\n• Visa sponsorship\n2) Gym");
    expect(segments.map((s) => s.text)).toEqual(["Benefits", "Remote work", "Visa sponsorship", "Gym"]);
    expect(segments.map((s) => s.listItem)).toEqual([false, true, true, true]);
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
    const segments = cut(description);
    expect(segments.map((s) => s.text)).toEqual(["Visa sponsorship:\nNot available.", "Other text."]);
    expect(segments[0]?.start).toBe(0);
  });

  it("does not join a heading with a list that follows, nor a long line ending in ':'", () => {
    expect(texts("What we offer:\n- Relocation")).toEqual(["What we offer:", "Relocation"]);
    const long = `${"word ".repeat(15)}ends here:`;
    expect(texts(`${long}\nNext line.`)).toEqual([long, "Next line."]);
  });

  it("joins a markdown heading and a short line without end punctuation with the next line", () => {
    const segments = cut("## Visa sponsorship\nNot available for this role.");
    expect(segments.map((s) => s.text)).toEqual(["Visa sponsorship\nNot available for this role."]);
    expect(segments[0]?.listItem).toBe(false);
    expect(texts("Visa sponsorship\nNot available.")).toEqual(["Visa sponsorship\nNot available."]);
    expect(texts("Visa sponsorship\nNot available")).toEqual(["Visa sponsorship\nNot available"]);
  });

  it("does not join a line ending in punctuation, a list item or a line longer than the limit", () => {
    expect(texts("We are a team.\nNext line.")).toEqual(["We are a team.", "Next line."]);
    expect(texts("- Visa sponsorship\nNot available.")).toEqual(["Visa sponsorship", "Not available."]);
    expect(cut("Visa sponsorship for everyone\nNot available.", { headingMaxChars: 10 }).map((s) => s.text)).toEqual(["Visa sponsorship for everyone", "Not available."]);
  });

  it("lets a heading stand alone when the next line is itself a heading, and never chains joins", () => {
    // the sub-heading takes the content line
    expect(texts("## Benefits\nVisa sponsorship\nNot available.")).toEqual(["Benefits", "Visa sponsorship\nNot available."]);
    // "Benefits" heads the list, so "Not available" is the content of the first heading
    expect(texts("Visa sponsorship:\nNot available\nBenefits\n- Gym")).toEqual(["Visa sponsorship:\nNot available", "Benefits", "Gym"]);
    // short lines pair up, two by two
    expect(texts("Remote work\nVisa sponsorship\nGym\nFree lunch")).toEqual(["Remote work\nVisa sponsorship", "Gym\nFree lunch"]);
  });

  it("cuts only the kept lines, a heading together with its next line", () => {
    const description = "Intro sentence. More.\nVisa sponsorship\nNot available.\nOther line.\n- Relocation support";
    const kept = cut(description, { keep: (start, end) => /visa|relocation/iu.test(description.slice(start, end)) });
    expect(kept.map((s) => s.text)).toEqual(["Visa sponsorship\nNot available.", "Relocation support"]);
    expect(cut(description, { keep: () => false })).toEqual([]);
    const all = cut(description);
    for (const segment of kept) expect(all).toContainEqual(segment);
  });

  it("gives each list item the line that introduces its list, and nothing else", () => {
    const description = "What we can't offer:\n- Visa sponsorship\n- Relocation package";
    const segments = cut(description);
    const heading = { start: 0, end: "What we can't offer:".length };
    expect(segments.map((s) => [s.text, s.listHeading])).toEqual([
      ["What we can't offer:", undefined],
      ["Visa sponsorship", heading],
      ["Relocation package", heading],
    ]);
    // a long line ending in ":" heads its list too; a sentence does not, and a line in between ends the list
    const long = `${"word ".repeat(15)}ends here:`;
    expect(cut(`${long}\n- Gym`)[1]?.listHeading).toEqual({ start: 0, end: long.length });
    expect(cut("We are a team.\n- Gym")[1]?.listHeading).toBeUndefined();
    expect(cut("Benefits:\n- Gym\nThe team is small.\n- Lunch").map((s) => s.listHeading === undefined)).toEqual([true, false, true, true]);
    // the heading line need not be kept for its items to carry it
    const kept = cut(description, { keep: (start, end) => /visa/iu.test(description.slice(start, end)) });
    expect(kept).toEqual([{ text: "Visa sponsorship", start: 23, end: 39, listItem: true, listHeading: heading }]);
  });

  it("marks where the heading of a joined piece ends", () => {
    const segments = cut("Intro.\nVisa sponsorship\nWe can't help. Ask us.");
    expect(segments.map((s) => [s.text, s.headingEnd])).toEqual([
      ["Intro.", undefined],
      ["Visa sponsorship\nWe can't help.", "Intro.\nVisa sponsorship".length],
      ["Ask us.", undefined],
    ]);
  });

  it("returns nothing for an empty or blank text", () => {
    expect(cut("")).toEqual([]);
    expect(cut("  \n \n")).toEqual([]);
  });
});
