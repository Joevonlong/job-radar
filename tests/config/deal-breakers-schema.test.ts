import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";
import { nestedQuantifierReason } from "@/lib/config/schemas/common";
import { DEAL_BREAKER_DEFAULTS } from "@/lib/config/schemas/pipeline";
import { preferencesSchema } from "@/lib/config/schemas/preferences";

import { shippedYaml } from "./helpers";

const base = (): Record<string, unknown> => {
  const raw = structuredClone(shippedYaml("profile.example/preferences.yaml"));
  delete raw.config_version;
  return raw;
};
const withRules = (rules: unknown) => preferencesSchema.safeParse({ ...base(), deal_breakers: rules });
const issues = (rules: unknown) => {
  const result = withRules(rules);
  return result.success ? [] : result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
};
const gate = { id: "gate", label: "Gate", type: "language_gate" };
const phrase = (extra: Record<string, unknown>) => ({ id: "p", label: "Phrase", type: "phrase", ...extra });

describe("preferences.yaml deal_breakers", () => {
  it("is optional: a file without it reads as no rules", () => {
    const result = preferencesSchema.parse(base());
    expect(result.deal_breakers).toEqual([]);
  });

  it("fills in the defaults of a rule", () => {
    const result = withRules([gate, phrase({ terms: ["Rust"] })]);
    expect(result.success && result.data.deal_breakers).toEqual([
      { id: "gate", label: "Gate", type: "language_gate", enabled: true },
      { id: "p", label: "Phrase", type: "phrase", enabled: true, terms: ["Rust"], patterns: [], scope: "any", unless: [] },
    ]);
  });

  it("refuses a duplicate id, at the second rule", () => {
    expect(issues([gate, { ...gate, label: "Again" }])).toEqual([{ path: "deal_breakers.1.id", message: 'duplicate id "gate"' }]);
  });

  it("refuses ids that are not slugs, empty and long labels", () => {
    expect(issues([{ ...gate, id: "Gate One" }])[0]?.path).toBe("deal_breakers.0.id");
    expect(issues([{ ...gate, label: "" }])[0]?.path).toBe("deal_breakers.0.label");
    expect(issues([{ ...gate, label: "x".repeat(61) }])[0]?.path).toBe("deal_breakers.0.label");
  });

  it("refuses an unknown type, an unknown key and an invalid level", () => {
    expect(issues([{ ...gate, type: "travel" }])[0]?.path).toBe("deal_breakers.0.type");
    expect(issues([{ ...gate, terms: ["x"] }])[0]?.path).toBe("deal_breakers.0");
    expect(issues([{ ...gate, at_least: "D1" }])[0]?.path).toBe("deal_breakers.0.at_least");
  });

  it("needs a term or a pattern in a phrase rule", () => {
    expect(issues([phrase({ unless: ["no"] })])).toEqual([{ path: "deal_breakers.0.terms", message: "needs at least one term or pattern" }]);
  });

  it("refuses an invalid regular expression, with its path", () => {
    expect(issues([phrase({ patterns: ["ok", "(unclosed"] })])).toEqual([{ path: "deal_breakers.0.patterns.1", message: "must be a valid regular expression" }]);
    expect(issues([phrase({ terms: ["x"], unless: ["[z-a]"] })])[0]?.path).toBe("deal_breakers.0.unless.0");
  });

  it.each(["(a+)+", "(\\w*)*", "(x+)*", "(x|y+)+", "((a+)b)+", "(?:a+){2,}", "(a{2,3}){2}"])("refuses the nested quantifier %s", (pattern) => {
    const found = issues([phrase({ patterns: [pattern] })]);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toMatch(/^must not nest quantifiers/);
  });

  it.each(["(?:ab)+", "(a+)?", "[(a+)]+", "\\((a)\\)+", "(a{1}){3}", "(a+?)b+", "Reisetätigkeit.{0,30}(?:[5-9]\\d|100)\\s?%", "\\bno travel\\b"])("accepts %s", (pattern) => {
    expect(nestedQuantifierReason(pattern)).toBeNull();
    expect(issues([phrase({ patterns: [pattern] })])).toEqual([]);
  });

  it("refuses more than 50 rules and patterns longer than 500 characters whatever pipeline.yaml says", () => {
    expect(issues(Array.from({ length: 51 }, (_, i) => ({ ...gate, id: `g${i}` })))[0]?.path).toBe("deal_breakers");
    expect(issues([phrase({ patterns: ["a".repeat(501)] })])[0]?.path).toBe("deal_breakers.0.patterns.0");
  });
});

describe("pipeline.yaml filter.deal_breakers", () => {
  const pipelineFile = (edit: (filter: Record<string, unknown>) => void) => {
    const raw = structuredClone(shippedYaml("pipeline.yaml"));
    delete raw.config_version;
    edit(raw.filter as Record<string, unknown>);
    return configRegistry.pipeline.schema.safeParse(raw);
  };

  it("defaults when the block is missing", () => {
    const result = pipelineFile((filter) => void delete filter.deal_breakers);
    expect(result.success && result.data.filter.deal_breakers).toEqual(DEAL_BREAKER_DEFAULTS);
  });

  it("defaults a missing value and refuses limits above the schema's", () => {
    const partial = pipelineFile((filter) => void (filter.deal_breakers = { max_rules: 5 }));
    expect(partial.success && partial.data.filter.deal_breakers).toEqual({ ...DEAL_BREAKER_DEFAULTS, max_rules: 5 });
    expect(pipelineFile((filter) => void (filter.deal_breakers = { max_rules: 51 })).success).toBe(false);
    expect(pipelineFile((filter) => void (filter.deal_breakers = { max_pattern_chars: 501 })).success).toBe(false);
    expect(pipelineFile((filter) => void (filter.deal_breakers = { unknown: 1 })).success).toBe(false);
  });
});
