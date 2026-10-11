import { describe, expect, it } from "vitest";

import { findQuoteTerm } from "@/lib/signals/rules";

import { candidatesOf, rawCategories, rawCategory, shippedInterests, tiersOf } from "./helpers";

const by = (text: string, tier: string) => candidatesOf(text).filter((c) => c.tier === tier);

describe("T2 equity", () => {
  it("finds the usual words", () => {
    for (const text of [
      "We offer equity in the company.",
      "Participation in our stock options programme",
      "ESOP and VSOP for every employee",
      "Restricted stock units vesting over four years.",
      "Employee shares programme",
      "Virtuelle Anteile (VSOP) für alle",
      "Mitarbeiterbeteiligung am Unternehmen",
    ]) {
      expect(by(text, "T2"), text).toHaveLength(1);
    }
  });

  it("does not fire on diversity, equity and inclusion or private equity", () => {
    for (const text of [
      "We care about diversity, equity and inclusion.",
      "Diversity, Equity, and Inclusion matter to us",
      "Backed by Vista Equity Partners, a global investment firm.",
      "Our work on equity and equality in tech",
      "Who shares our passion for data?",
    ]) {
      expect(by(text, "T2"), text).toHaveLength(0);
    }
  });

  it("still finds equity in a sentence that also mentions DEI", () => {
    expect(by("We offer equity. We value diversity, equity and inclusion.", "T2")).toHaveLength(1);
  });
});

describe("T3 competitive pay", () => {
  it("finds English and German phrasings", () => {
    for (const text of [
      "Competitive salary package & benefits",
      "We reward impact with competitive pay.",
      "A highly competitive compensation package",
      "above-market compensation",
      "Eine attraktive Vergütung, die Deine Leistungen wertschätzt.",
      "Neben einem attraktiven, marktgerechten Vergütungspaket erwartet Sie",
      "überdurchschnittliches Gehalt",
      "Top-Gehalt und Benefits",
    ]) {
      expect(by(text, "T3"), text).toHaveLength(1);
    }
  });

  it("ignores competitive things that are not pay", () => {
    expect(by("We operate in a competitive market and need competitive thinkers.", "T3")).toHaveLength(0);
  });
});

describe("T4 candidates", () => {
  it("are marked as waiting for the AI", () => {
    const found = by("Annual performance bonus and a 13. Gehalt", "T4");
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((c) => c.aiConfirmOnly)).toBe(true);
  });

  it("are plain signals when ai_confirm_only is switched off", () => {
    const open = shippedInterests((raw) => {
      rawCategory(raw, "T4").ai_confirm_only = false;
    });
    expect(candidatesOf("Signing bonus of two months", open).find((c) => c.tier === "T4")?.aiConfirmOnly).toBe(false);
  });

  it("skip bonus points and being a bonus", () => {
    expect(by("Bonus points if you know Rust.", "T4")).toHaveLength(0);
    expect(by("Experience with Kubernetes is a bonus.", "T4")).toHaveLength(0);
    expect(by("Experience with Kubernetes would be a nice bonus", "T4")).toHaveLength(0);
  });
});

describe("benefit tags", () => {
  it("are found once per tag, with a quote, and carry no bonus tier", () => {
    const found = by("- 30 Tage Urlaub\n- Zuschuss zum Deutschlandticket\n- JobRad\n- Deutschlandticket for everyone", "tag");
    expect(found.map((c) => c.kind).sort()).toEqual(["28+ vacation days", "Deutschlandticket", "JobRad"]);
  });

  it("reads 28 or more vacation days only", () => {
    expect(by("25 days of vacation", "tag")).toHaveLength(0);
    expect(by("28 paid leave days", "tag")).toHaveLength(1);
    expect(by("30 days of paid vacation", "tag")).toHaveLength(1);
  });

  it("does not count a negated relocation", () => {
    expect(by("without the need for visa sponsorship or relocation assistance", "tag")).toHaveLength(0);
    expect(by("We offer relocation assistance for the right person.", "tag")).toHaveLength(1);
  });
});

describe("quotes and limits", () => {
  const jd = "## Benefits\n- Competitive salary package & benefits\n- Stock options for everyone. Free lunch every day.\n\nSalary: €80,000 - €120,000 gross a year";

  it("quote the sentence of the hit, verbatim, with its offset (C7)", () => {
    const found = candidatesOf(jd);
    expect(found.map((c) => c.tier)).toEqual(["T1", "T2", "T3"]);
    for (const c of found) {
      expect(jd.slice(c.quoteOffset, c.quoteOffset + c.quote.length)).toBe(c.quote);
      expect(c.quote.length).toBeGreaterThan(0);
    }
    expect(found.find((c) => c.tier === "T2")?.quote).toBe("Stock options for everyone.");
    expect(found.find((c) => c.tier === "T3")?.quote).toBe("Competitive salary package & benefits");
  });

  it("keep at most per_category_max signals per category and one per sentence", () => {
    const many = Array.from({ length: 6 }, (_, i) => `Line ${i}: we offer equity and stock options.`).join("\n");
    expect(by(many, "T2")).toHaveLength(shippedInterests().limits.per_category_max);
    expect(by("We offer equity and stock options and ESOP.", "T2")).toHaveLength(1);
  });

  it("cut a very long sentence around the hit and stay a substring", () => {
    const long = `${"word ".repeat(120)}we offer a competitive salary${" more".repeat(120)}.`;
    const found = by(long, "T3")[0];
    expect(found).toBeDefined();
    expect(found?.quote.length).toBeLessThanOrEqual(shippedInterests().limits.quote_max_chars);
    expect(found?.quote).toContain("competitive salary");
    expect(long.includes(found?.quote ?? "?")).toBe(true);
  });

  it("find nothing in an empty or unrelated text", () => {
    expect(candidatesOf("")).toEqual([]);
    expect(tiersOf(candidatesOf("We build rockets and play table tennis."))).toEqual([]);
  });
});

describe("user-defined categories", () => {
  const withVisa = () =>
    shippedInterests((raw) => {
      const categories = rawCategories(raw);
      categories.splice(1, 0, {
        id: "visa",
        kind: "keyword",
        label: { en: "Visa sponsorship" },
        color: "violet",
        weight: 4,
        ai_definition: "the employer sponsors a work visa",
        keywords: ["visa sponsorship"],
        patterns: ["\\bsponsor(?:s|ship)?\\s+(?:your\\s+)?(?:work\\s+)?visa"],
        exclude: ["\\bno\\s+visa\\s+sponsorship"],
      });
      categories.push({ id: "remote", kind: "tag", label: { en: "Remote budget" }, color: "olive", weight: 0, tags: ["Wellpass"] });
    });

  it("finds a keyword category's words and patterns, with its kind defaulting to the id", () => {
    const found = candidatesOf("We offer visa sponsorship. We sponsor your work visa too.", withVisa()).filter((c) => c.tier === "visa");
    expect(found).toHaveLength(2);
    expect(found[0]?.kind).toBe("visa");
    expect(found[0]?.aiConfirmOnly).toBe(false);
  });

  it("applies the category's exclusions", () => {
    expect(candidatesOf("Sorry, no visa sponsorship is possible.", withVisa()).filter((c) => c.tier === "visa")).toHaveLength(0);
  });

  it("sorts by the category order of the list, then by place", () => {
    const found = candidatesOf("Visa sponsorship available. Salary: €80,000 - €120,000 gross a year. Stock options for all.", withVisa());
    expect(tiersOf(found).filter((tier) => tier !== "tag")).toEqual(["T1", "visa", "T2"]);
  });

  it("finds the tags of every tag category, marked as tags", () => {
    const found = candidatesOf("We pay for Wellpass and the Deutschlandticket.", withVisa());
    expect(found.filter((c) => c.isTag).map((c) => `${c.tier}:${c.kind}`)).toEqual(["tag:Deutschlandticket", "remote:Wellpass"]);
  });

  it("finds nothing for a category that was deleted", () => {
    const retired = shippedInterests((raw) => {
      const categories = rawCategories(raw);
      const index = categories.findIndex((c) => c.id === "T2");
      const [t2] = categories.splice(index, 1);
      (raw.signals as { retired_categories: unknown[] }).retired_categories = [t2];
    });
    expect(candidatesOf("Stock options for all.", retired).filter((c) => c.tier === "T2")).toHaveLength(0);
    expect(findQuoteTerm("Stock options for all.", "T2", retired)).toBeNull();
  });

  it("works without an amount category", () => {
    const noAmount = shippedInterests((raw) => {
      const categories = rawCategories(raw);
      categories.splice(categories.findIndex((c) => c.id === "T1"), 1);
    });
    expect(candidatesOf("Salary: €80,000 - €120,000 gross a year.", noAmount).filter((c) => c.value !== null)).toHaveLength(0);
  });

  it("marks a category's candidates when it waits for the AI", () => {
    const strict = shippedInterests((raw) => {
      rawCategory(raw, "T3").ai_confirm_only = true;
    });
    expect(candidatesOf("Competitive salary for all.", strict).find((c) => c.tier === "T3")?.aiConfirmOnly).toBe(true);
  });
});
