// @vitest-environment node
import { describe, expect, it } from "vitest";

import { segmentText, type TextSegment } from "@/lib/job-checks/segment";
import { evergreenWording, listHeadingFinder, wholeLineHeading } from "@/lib/ghost/signals";
import type { CompiledGhostRules } from "@/lib/ghost/rules";

import { fixtureRules } from "./helpers";

const LIST_LINE = /^\s*(?:[-*•–·]\s+|\d{1,3}[.)]\s+)/u;

/**
 * The reference: the walk up from each list item on its own, as it read before the finder shared the walks (a long list was read
 * again for every item in it). One change: a description that starts with a line break ends the walk at its start, where the old
 * walk never ended.
 */
function referenceListHeading(segment: TextSegment, rules: CompiledGhostRules, description: string): string | null {
  if (!segment.listItem) return null;
  let lineStart = description.lastIndexOf("\n", segment.start - 1) + 1;
  while (lineStart > 0) {
    const lineEnd = lineStart - 1;
    lineStart = lineEnd === 0 ? 0 : description.lastIndexOf("\n", lineEnd - 1) + 1;
    const line = description.slice(lineStart, lineEnd);
    if (line.trim() === "" || LIST_LINE.test(line)) continue;
    return wholeLineHeading(line, rules, true);
  }
  return null;
}

/** A small seeded generator (mulberry32): the same texts on every run. */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HEADINGS = ["Responsibilities", "Your tasks:", "What will you be doing?", "What you'll do...", "Deine Aufgaben", "Was dich erwartet?", "About us", "Benefits:", "# The role", "Requirements", "Why join us?"];
const ITEMS = ["- not always hiring", "- no open job", "- We are always hiring.", "* Build our talent pool", "• Own the roadmap", "  - nested item", "    * deeper item", "1. First step", "12) Twelfth step", "123. Long list", "1234. no list item", "– Teil des Talentpools", "· Mitarbeit"];
const TEXT = ["We build software for logistics.", "Join us.", "Our team is small", "x", "Apply now!"];

function description(next: () => number): string {
  const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
  const lines: string[] = [];
  const count = 1 + Math.floor(next() * 30);
  for (let i = 0; i < count; i++) {
    const roll = next();
    lines.push(roll < 0.15 ? pick(HEADINGS) : roll < 0.6 ? pick(ITEMS) : roll < 0.75 ? pick(TEXT) : roll < 0.95 ? "" : "   ");
  }
  return (next() < 0.1 ? "\n" : "") + lines.join("\n");
}

describe("listHeadingFinder", () => {
  const rules = fixtureRules();
  const segmentsOf = (text: string): TextSegment[] => segmentText(text, { abbreviations: rules.abbreviations, headingMaxChars: rules.settings.heading_max_chars });

  it("finds the reference's heading for every list item, whatever the order the items are asked in", () => {
    const next = random(20261013);
    const differences: string[] = [];
    let items = 0;
    let headings = 0;
    for (let n = 0; n < 2000; n++) {
      const text = description(next);
      const segments = segmentsOf(text).filter((segment) => segment.listHeading === undefined);
      const inOrder = listHeadingFinder(text, rules);
      const reversed = listHeadingFinder(text, rules);
      const expected = segments.map((segment) => referenceListHeading(segment, rules, text));
      const forward = segments.map((segment) => inOrder(segment));
      const backward = [...segments].reverse().map((segment) => reversed(segment)).reverse();
      segments.forEach((segment, i) => {
        if (segment.listItem) items += 1;
        if (expected[i] !== null) headings += 1;
        if (forward[i] !== expected[i] || backward[i] !== expected[i]) differences.push(`${JSON.stringify(text)} @${segment.start}: ${forward[i]} / ${backward[i]} ≠ ${expected[i]}`);
      });
    }
    expect(differences.slice(0, 5)).toEqual([]);
    expect(items).toBeGreaterThan(5000);
    expect(headings).toBeGreaterThan(1000);
  });

  it("ends at the start of a description that opens with a line break", () => {
    expect(evergreenWording("\n- We are always hiring.", rules)).toMatchObject({ patternId: "always_hiring" });
    expect(evergreenWording("\n\n- x\n- We are always hiring.", rules)).toMatchObject({ patternId: "always_hiring" });
  });

  it("reads the segmenter's heading of a list item as a heading (the list's line above it)", () => {
    const text = "Your responsibilities:\n- Build things\n- Ship them";
    const find = listHeadingFinder(text, rules);
    const items = segmentsOf(text).filter((segment) => segment.listHeading !== undefined);
    expect(items).toHaveLength(2);
    expect(items.map((segment) => find(segment))).toEqual(["Your responsibilities", "Your responsibilities"]);
  });
});

describe("list headings read once per list", () => {
  const rules = fixtureRules();
  const long = (words: number): string => "lorem ipsum dolor sit amet ".repeat(words).trim();

  it("keeps two long headings apart: the items under the duties heading do not count, those under the other one do", () => {
    const text = `${long(40)} your responsibilities:\n- We are always hiring\n- We are always hiring\n\n${long(40)}:\n- We are always hiring`;
    const found = evergreenWording(text, rules);
    expect(found).toMatchObject({ patternId: "always_hiring", offset: text.lastIndexOf("We are always hiring") });
    // and the other way round
    const swapped = `${long(40)}:\n- We are always hiring\n\n${long(40)} your responsibilities:\n- We are always hiring`;
    expect(evergreenWording(swapped, rules)).toMatchObject({ offset: swapped.indexOf("We are always hiring") });
  });

  it("keeps a negated heading and one without a cue apart", () => {
    const text = `${long(40)} not:\n- We are always hiring\n- We are always hiring\n\n${long(40)}:\n- We are always hiring`;
    expect(evergreenWording(text, rules)).toMatchObject({ offset: text.lastIndexOf("We are always hiring") });
  });

  it("negates every item under a negated heading, blank lines between the items included, and items negated themselves", () => {
    expect(evergreenWording("We do not offer the following:\n- We are always hiring\n\n- always hiring\n- not always hiring", rules)).toBeNull();
  });

  it("skips the items under a duties heading whether or not a pattern checks negation", () => {
    const unchecked: CompiledGhostRules = { ...rules, evergreen: rules.evergreen.map((pattern) => ({ ...pattern, checkNegation: false })) };
    const text = `${long(40)} your responsibilities:\n- We are always hiring\n- We are always hiring`;
    expect(evergreenWording(text, unchecked)).toBeNull();
    expect(evergreenWording(text.replace("your responsibilities", "our perks"), unchecked)).toMatchObject({ patternId: "always_hiring" });
  });

  it("reads the next line of a heading once for all its hits", () => {
    expect(evergreenWording("always hiring, always hiring\nnot now", rules)).toBeNull();
    expect(evergreenWording("always hiring, always hiring\nsee below", rules)).toMatchObject({ patternId: "always_hiring", offset: 0 });
  });

  it("does not keep what it read between calls (the same rules, headings at the same offset)", () => {
    expect(evergreenWording("Benefits not:\n- We are always hiring", rules)).toBeNull();
    expect(evergreenWording("Benefits now:\n- We are always hiring", rules)).toMatchObject({ patternId: "always_hiring" });
    expect(evergreenWording("Your tasks:\n- We are always hiring", rules)).toBeNull();
    expect(evergreenWording("Your perks:\n- We are always hiring", rules)).toMatchObject({ patternId: "always_hiring" });
  });

  it("reads only the items that the prefilter keeps under one heading", () => {
    expect(evergreenWording(`${long(40)} not:\n- x\n- We are always hiring\n- y\n- We are always hiring`, rules)).toBeNull();
    expect(evergreenWording(`${long(40)}:\n- x\n- We are always hiring\n- y`, rules)).toMatchObject({ patternId: "always_hiring" });
  });
});
