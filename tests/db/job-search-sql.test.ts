// @vitest-environment node
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { escapeSearchRegex, jobHasCountryIn, jobSearchCondition, jobSearchOrderBy, searchPhrasePattern, searchTermPattern } from "@/lib/db/queries/job-search";

import { searchPlan } from "../fixtures/job-search";

const dialect = new PgDialect();
const render = (q: string, all = false) => dialect.sqlToQuery(jobSearchCondition(searchPlan(q), all ? "all" : "summary")!);
const pattern = (q: string) => searchTermPattern(searchPlan(q).terms[0]!);
// JavaScript lacks POSIX space classes; use its whitespace equivalent to exercise ARE pattern examples without a database.
const matches = (pattern: string, value: string) => new RegExp(pattern.replaceAll("[:space:]", "\\s"), "iu").test(value);

describe("Postgres search patterns", () => {
  it.each([[".", "\\."], ["(", "\\("], ["\\", "\\\\"], ["%", "%"], ["[", "\\["]])("escapes %s as a literal", (input, escaped) => {
    expect(escapeSearchRegex(input)).toBe(escaped);
  });

  it("escapes the entire ARE metacharacter set", () => {
    expect(escapeSearchRegex("\\^$.|?*+()[]{}")).toBe("\\\\\\^\\$\\.\\|\\?\\*\\+\\(\\)\\[\\]\\{\\}");
  });

  it("uses explicit Latin/mark/symbol word boundaries while allowing adjacent Han", () => {
    const ai = pattern("AI");
    expect(ai).toContain("(?<![A-Za-z0-9");
    expect(ai).toContain("(?![A-Za-z0-9");
    expect(ai).not.toContain("[:alnum:]");
    expect(matches(ai, "AI工程师")).toBe(true);
    for (const value of ["Maintenance", "Airbus", "éAI", "AIé", "AI\u0301", "AI+", "AI#"]) expect(matches(ai, value), value).toBe(false);
    for (const value of ["C++", "C#"]) expect(matches(pattern("C"), value)).toBe(false);
    expect(matches(pattern("C"), "embedded C")).toBe(true);
  });

  it("requires only a left boundary for prefixes, and both for programming symbols", () => {
    expect(matches(pattern("quillfeath"), "Quillfeather Labs")).toBe(true);
    expect(matches(pattern("quillfeath"), "Prequillfeather")).toBe(false);
    expect(matches(pattern("eng"), "Engineer")).toBe(false);
    for (const q of ["C++", "C#", ".NET", "node.js"]) {
      expect(matches(pattern(q), `Senior ${q} Developer`)).toBe(true);
      expect(matches(pattern(q), `Some${q}`)).toBe(false);
      expect(matches(pattern(q), `${q}suffix`)).toBe(false);
    }
  });

  it("limits phrase separators, without crossing Han or other scripts", () => {
    const p = searchPhrasePattern(["product", "manager"]);
    expect(p).toContain("[[:space:]/._-]+");
    for (const value of ["Product Manager", "Product/Manager", "Product.Manager", "Product_Manager", "Product-Manager"]) expect(matches(p, value)).toBe(true);
    for (const value of ["Product产品Manager", "ProductЖManager", "ProductManager", "Product Marketing Manager"]) expect(matches(p, value)).toBe(false);
    expect(matches(searchPhrasePattern(["ai", "工程师", "manager"]), "AI工程师 Manager")).toBe(true);
    expect(pattern("产品经理")).toBe("产品经理");
  });
});

describe("bound search SQL", () => {
  it("distinguishes absent search from punctuation with no valid terms", () => {
    expect(jobSearchCondition(searchPlan(null))).toBeUndefined();
    expect(dialect.sqlToQuery(jobSearchCondition(searchPlan("%"))!).sql).toBe("false");
  });

  it("normalizes each field, binds patterns and needs no outer company join or search vector", () => {
    const { sql, params } = render('"product manager"', true);
    expect(sql).toContain("normalize(coalesce(");
    // normalize() runs only for text that is neither ASCII nor NFKC-normalized already
    expect(sql).toContain("octet_length(coalesce(");
    expect(sql).toContain("is nfkc normalized");
    // the marker-free translation is computed once per row, not once per use
    expect(sql).toContain("offset 0) plain");
    expect(sql).toContain("unnest(c.aliases)");
    expect(sql).toContain("c.id = \"jobs\".\"company_id\"");
    expect(sql).toContain("jsonb_typeof");
    expect(sql).toContain("source_hash = encode(sha256(");
    expect(sql).toContain("regexp_replace(t.content,");
    expect(sql).not.toContain("search_tsv");
    expect(sql).not.toContain("product");
    expect(params).toContain(pattern('"product manager"'));
    expect(render("AI").sql).not.toContain("translations t");
    expect(render("AI").sql).not.toContain('"jobs"."description"');
  });

  it("keeps bare countries country-only and names also searchable in text", () => {
    expect(render("DE").params).toEqual(["DE"]);
    expect(render("DE").sql).not.toContain('"jobs"."title"');
    expect(render("Germany").sql).toContain('"jobs"."title"');
    expect(dialect.sqlToQuery(jobHasCountryIn(["de", "FR"])).params).toEqual(["DE", "FR"]);
  });

  it("discounts prefix text weights, takes greatest per term, and never forces filtered jobs last", () => {
    const plan = searchPlan("Germany");
    const keys = jobSearchOrderBy(plan, "all").map((key) => dialect.sqlToQuery(key));
    expect(keys).toHaveLength(2); // No constant ORDER BY key when the full-query phrase is absent.
    expect(keys.at(-1)?.sql).toContain("greatest(0,");
    expect(keys.at(-1)?.params).toContain(4.8);
    expect(keys.at(-1)?.params).toContain(3); // Country weight is undiscounted.
    expect(keys.every((key) => !key.sql.includes("filter_result"))).toBe(true);
    expect(jobSearchOrderBy(searchPlan("AI AI"), "all").map((key) => dialect.sqlToQuery(key))).toEqual(jobSearchOrderBy(searchPlan("AI"), "all").map((key) => dialect.sqlToQuery(key)));
  });
});
