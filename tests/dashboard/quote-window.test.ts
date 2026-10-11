import { describe, expect, it } from "vitest";

import { fitsWhole, quoteWindow } from "@/lib/dashboard/quote-window";

const MAX = 110;
const LEAD = 28;

describe("quoteWindow", () => {
  it("shows a short quote whole", () => {
    const text = "Competitive salary and VSOP options.";
    expect(fitsWhole(text, MAX)).toBe(true);
    expect(quoteWindow(text, { start: 0, end: 11 }, MAX, LEAD)).toEqual({ start: 0, end: text.length, cutStart: false, cutEnd: false });
  });

  it("starts a long quote at the beginning when the term is near it, and cuts the end at a word boundary", () => {
    const text = `${"We offer a competitive salary".padEnd(40, " ")}${"lorem ipsum dolor sit amet ".repeat(12)}end.`;
    const at = text.indexOf("competitive");
    const view = quoteWindow(text, { start: at, end: at + "competitive".length }, MAX, LEAD);
    expect(view.start).toBe(0);
    expect(view.cutStart).toBe(false);
    expect(view.cutEnd).toBe(true);
    expect(view.end).toBeLessThanOrEqual(MAX);
    expect(text[view.end]).toBe(" ");
  });

  it("moves the window to the term when it is far into a long quote, keeping a lead of words before it", () => {
    const filler = "lorem ipsum dolor sit amet consectetur ".repeat(6);
    const text = `${filler}Up to €120k package + VSOP ${filler}`;
    const at = text.indexOf("€120k");
    const view = quoteWindow(text, { start: at, end: at + 5 }, MAX, LEAD);
    expect(view.cutStart).toBe(true);
    expect(view.start).toBeLessThanOrEqual(at);
    expect(at - view.start).toBeLessThanOrEqual(LEAD + 12);
    expect(view.end).toBeGreaterThanOrEqual(at + 5);
    expect(text.slice(view.start, view.end)).toContain("€120k");
    expect(view.end - view.start).toBeLessThanOrEqual(MAX);
    expect(text[view.start - 1]).toBe(" ");
  });

  it("gives a term longer than the window the room it needs", () => {
    const text = `${"x".repeat(20)} ${"y".repeat(150)} ${"z".repeat(20)}`;
    const view = quoteWindow(text, { start: 21, end: 171 }, MAX, LEAD);
    expect(view.end).toBeGreaterThanOrEqual(171);
  });

  it("starts at the beginning when it does not know the term", () => {
    const text = "word ".repeat(60);
    const view = quoteWindow(text, null, MAX, LEAD);
    expect(view).toMatchObject({ start: 0, cutStart: false, cutEnd: true });
    expect(view.end).toBeLessThanOrEqual(MAX);
  });
});
