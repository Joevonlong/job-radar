import { describe, expect, it } from "vitest";

import { locateQuote, sentenceAround } from "@/lib/signals/quote";

describe("sentenceAround", () => {
  const text = "Intro line.\n- First point. Second point has equity in it. Third point.\nLast line";

  it("returns the sentence of the hit without the list marker, as an exact substring", () => {
    const start = text.indexOf("equity");
    const { quote, offset } = sentenceAround(text, { start, end: start + 6 }, 280);
    expect(quote).toBe("Second point has equity in it.");
    expect(text.slice(offset, offset + quote.length)).toBe(quote);
  });

  it("strips a leading bullet when the hit is the first word", () => {
    const t = "- Equity for everyone\n- Other";
    expect(sentenceAround(t, { start: 2, end: 8 }, 280).quote).toBe("Equity for everyone");
  });

  it("does not split inside 85.000", () => {
    const t = "Salary 85.000 - 95.000 EUR per year. Next.";
    const start = t.indexOf("85.000");
    expect(sentenceAround(t, { start, end: start + 6 }, 280).quote).toBe("Salary 85.000 - 95.000 EUR per year.");
  });

  it("clips to the limit around the hit at word boundaries", () => {
    const t = `${"alpha ".repeat(50)}EQUITY${" omega".repeat(50)}`;
    const start = t.indexOf("EQUITY");
    const { quote, offset } = sentenceAround(t, { start, end: start + 6 }, 60);
    expect(quote.length).toBeLessThanOrEqual(60);
    expect(quote).toContain("EQUITY");
    expect(t.slice(offset, offset + quote.length)).toBe(quote);
    expect(quote.startsWith("alpha") || quote.startsWith("omega")).toBe(true);
  });
});

describe("locateQuote", () => {
  const jd = "We offer\nstock options and a\ncompetitive salary.";

  it("accepts an exact substring and reports its position", () => {
    expect(locateQuote(jd, "competitive salary")).toEqual({ quote: "competitive salary", offset: jd.indexOf("competitive salary") });
  });

  it("maps a whitespace-flexible quote onto the JD's own text", () => {
    const found = locateQuote(jd, "stock options and a competitive salary.");
    expect(found?.quote).toBe("stock options and a\ncompetitive salary.");
    expect(jd.includes(found?.quote ?? "?")).toBe(true);
  });

  it("rejects text that is not in the JD, an empty quote and changed words", () => {
    expect(locateQuote(jd, "unlimited vacation")).toBeNull();
    expect(locateQuote(jd, "   ")).toBeNull();
    expect(locateQuote(jd, "we offer stock option")).toBeNull();
    expect(locateQuote(jd, "COMPETITIVE SALARY")).toBeNull();
  });
});
