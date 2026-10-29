import { describe, expect, it } from "vitest";

import { mergeLayers, plainEqual } from "@/lib/config/merge";
import { recordKindAt, replaceRule } from "@/lib/config/overlay-rules";
import { containsUnset } from "@/lib/config/yaml-options";

import { effective, overlay, shippedValue } from "./overlay-helpers";

const SHIPPED = { a: { b: 1, c: [1, 2], d: { e: "x" } }, f: "y", g: null, h: 3 };

describe("mergeLayers rules", () => {
  it("merges mappings key by key: shipped keys keep their order, keys only the overlay has follow", () => {
    const merged = mergeLayers(SHIPPED, overlay("z: 1\na:\n  new: 2\n  d:\n    e2: z\n"));
    expect(merged).toEqual({ a: { b: 1, c: [1, 2], d: { e: "x", e2: "z" }, new: 2 }, f: "y", g: null, h: 3, z: 1 });
    expect(Object.keys(merged as object)).toEqual(["a", "f", "g", "h", "z"]);
  });

  it("lets a user scalar win", () => {
    expect(mergeLayers(SHIPPED, overlay("a:\n  b: 5\nf: other\n"))).toMatchObject({ a: { b: 5 }, f: "other" });
  });

  it("treats an explicit null as a value", () => {
    expect(mergeLayers(SHIPPED, overlay("h: null\na:\n  d: ~\n"))).toMatchObject({ h: null, a: { d: null } });
    // and a mapping over a shipped null replaces it
    expect(mergeLayers(SHIPPED, overlay("g:\n  k: 1\n"))).toMatchObject({ g: { k: 1 } });
  });

  it("replaces a list as a whole", () => {
    expect(mergeLayers(SHIPPED, overlay("a:\n  c: [3]\n"))).toMatchObject({ a: { c: [3] } });
    expect(mergeLayers(SHIPPED, overlay("a:\n  c: []\n"))).toMatchObject({ a: { c: [] } });
  });

  it("lets the user value replace when the types differ", () => {
    expect(mergeLayers(SHIPPED, overlay("a: 1\n"))).toMatchObject({ a: 1 });
    expect(mergeLayers(SHIPPED, overlay("f:\n  k: !unset\n  j: 2\n"))).toMatchObject({ f: { j: 2 } });
    expect(mergeLayers(SHIPPED, overlay("a:\n  c:\n    k: 1\n"))).toMatchObject({ a: { c: { k: 1 } } });
  });

  it("removes a key marked !unset, and ignores a marker on a key the shipped layer does not have", () => {
    const merged = mergeLayers(SHIPPED, overlay("a:\n  b: !unset\n  d: !unset\nmissing: !unset\nh: !unset\n"));
    expect(merged).toEqual({ a: { c: [1, 2] }, f: "y", g: null });
  });

  it("gives a copy of the shipped value without an overlay, and the shipped value under an empty one", () => {
    const merged = mergeLayers(SHIPPED, undefined);
    expect(merged).toEqual(SHIPPED);
    expect(merged).not.toBe(SHIPPED);
    expect(mergeLayers(SHIPPED, {})).toEqual(SHIPPED);
  });

  it("changes neither input and shares nothing with them", () => {
    const top = overlay("a:\n  d:\n    e: z\n  c: [9]\n");
    const before = JSON.stringify(SHIPPED);
    const merged = mergeLayers(SHIPPED, top) as { a: { c: number[]; d: object } };
    expect(JSON.stringify(SHIPPED)).toBe(before);
    merged.a.c.push(10);
    expect((top as { a: { c: number[] } }).a.c).toEqual([9]);
  });

  it("returns a value without markers that survives structuredClone", () => {
    const merged = mergeLayers(SHIPPED, overlay("a:\n  b: !unset\nn:\n  x: !unset\n  y: 1\n"));
    expect(containsUnset(merged)).toBe(false);
    expect(structuredClone(merged)).toEqual(merged);
    expect(merged).toMatchObject({ n: { y: 1 } });
  });
});

describe("mergeLayers on the three kinds of record", () => {
  it("entries (ai translation.glossary, scoring.language_penalty): merged entry by entry, !unset drops one", () => {
    expect(recordKindAt("ai", ["translation", "glossary"])).toBe("entries");
    const shipped = shippedValue("ai") as { translation: { glossary: Record<string, string> } };
    const merged = mergeLayers(shipped, overlay("translation:\n  glossary:\n    Solutions Engineer: !unset\n    Staff Engineer: Staff-Ingenieur\nscoring:\n  language_penalty:\n    B2: !unset\n"), {
      replaceAt: replaceRule("ai"),
    }) as { translation: { glossary: Record<string, string> }; scoring: { language_penalty: Record<string, number> } };
    expect(merged.translation.glossary).not.toHaveProperty("Solutions Engineer");
    expect(merged.translation.glossary["Staff Engineer"]).toBe("Staff-Ingenieur");
    expect(merged.translation.glossary["AI Engineer"]).toBe(shipped.translation.glossary["AI Engineer"]);
    expect(merged.scoring.language_penalty).toEqual({ C1: 20, C2: 25 });
    expect(() => effective("ai", merged)).not.toThrow();
  });

  it("whole (search keyword_groups): a user value replaces the shipped set", () => {
    expect(recordKindAt("search", ["keyword_groups"])).toBe("whole");
    const merged = mergeLayers(shippedValue("search"), overlay("keyword_groups:\n  mine: [Staff Engineer]\n"), { replaceAt: replaceRule("search") });
    expect((merged as { keyword_groups: unknown }).keyword_groups).toEqual({ mine: ["Staff Engineer"] });
    expect(() => effective("search", merged)).not.toThrow();
  });

  it("opaque (channels linkedin.*.input_template): replaced as a whole", () => {
    expect(recordKindAt("channels", ["linkedin", "apify", "input_template"])).toBe("opaque");
    const merged = mergeLayers(shippedValue("channels"), overlay("linkedin:\n  apify:\n    input_template:\n      query: \"{keywords}\"\n"), { replaceAt: replaceRule("channels") });
    expect((merged as { linkedin: { apify: { input_template: unknown } } }).linkedin.apify.input_template).toEqual({ query: "{keywords}" });
  });

  it("in a list item (signal-presets presets[].keywords): follows the list, which is replaced as a whole", () => {
    expect(recordKindAt("signalPresets", ["presets"])).toBeNull();
    const shipped = shippedValue("signalPresets") as { presets: { id: string }[] };
    const first = shipped.presets[0];
    const merged = mergeLayers(shipped, { presets: [{ ...first, keywords: { en: ["only"] } }] }, { replaceAt: replaceRule("signalPresets") }) as { presets: { keywords: unknown }[] };
    expect(merged.presets).toHaveLength(1);
    expect(merged.presets[0]?.keywords).toEqual({ en: ["only"] });
  });
});

describe("plainEqual", () => {
  it("compares mappings by key and lists by position", () => {
    expect(plainEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(plainEqual([1, 2], [2, 1])).toBe(false);
    expect(plainEqual({ a: undefined }, {})).toBe(false);
    expect(plainEqual(null, {})).toBe(false);
  });
});
