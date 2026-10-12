// @vitest-environment node
import { describe, expect, it } from "vitest";

import { quotesFoundInJd } from "@/lib/dashboard/jd";
import { evidenceMarkText, reasonSourceViews } from "@/lib/dashboard/reason-evidence";

describe("evidenceMarkText", () => {
  it("is the first line of the quote without a list bullet", () => {
    expect(evidenceMarkText("5+ years of Python\n- Experience with RAG")).toBe("5+ years of Python");
    expect(evidenceMarkText("- Python\n")).toBe("Python");
    expect(evidenceMarkText("\n  2. Docker  ")).toBe("Docker");
    expect(evidenceMarkText("   ")).toBe("");
  });
});

describe("reasonSourceViews", () => {
  const JD = "We build agents.\n- 5+ years of Python\n- Experience with RAG\nSalary: EUR 90,000";

  it("gives each jd quote a mark after the earlier quotes, reuses an earlier mark with the same text, and none to the others", () => {
    const prior = [{ text: "Salary: EUR 90,000" }];
    const views = reasonSourceViews(
      {
        v: 1,
        fit: [
          { basis: "jd", quote: "5+ years of Python\n- Experience with RAG", offset: 17 },
          { basis: "inferred", quote: null, offset: null },
          { basis: "jd", quote: "5+ years of Python", offset: 19 },
        ],
        gaps: [
          { basis: "jd", quote: "Salary: EUR 90,000", offset: 62 },
          { basis: "unstated", quote: null, offset: null },
          { basis: null, quote: null, offset: null },
        ],
      },
      prior,
    );
    expect(views.marks).toEqual(["5+ years of Python"]);
    expect(views.fit).toEqual([
      { basis: "jd", quote: "5+ years of Python\n- Experience with RAG", mark: 1 },
      { basis: "inferred", quote: null, mark: null },
      { basis: "jd", quote: "5+ years of Python", mark: 1 },
    ]);
    expect(views.gaps).toEqual([
      { basis: "jd", quote: "Salary: EUR 90,000", mark: 0 },
      { basis: "unstated", quote: null, mark: null },
      { basis: null, quote: null, mark: null },
    ]);
    // the JD panel finds the mark (the caller only offers the jump then)
    expect(quotesFoundInJd(JD, [...prior.map((q) => q.text), ...views.marks])).toEqual([true, true]);
  });

  it("has nothing for a score without evidence", () => {
    expect(reasonSourceViews(null, [{ text: "x" }])).toEqual({ marks: [], fit: [], gaps: [] });
  });
});
