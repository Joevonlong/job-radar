import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";

import type { JobScope } from "@/lib/jobs/constants";
import type { SearchPlan, SearchRanking, SearchTerm } from "@/lib/jobs/search-query";
import { STORED_MARKER_PATTERN } from "@/lib/translation/markers";

import type { Db } from "../client";
import { descriptionHashSql } from "../repos/translations";
import { uxTablesReady } from "../repos/ux-tables";
import { jobs } from "../schema";
import { latestScoreCte } from "./job-cards";
import { jobListWhere } from "./jobs";

export type SearchIn = "summary" | "all";
type SearchField = keyof SearchRanking["weights"];

// Explicit Unicode ranges: database locale must not turn Han or other scripts into word characters.
const WORD_CHARS = "[A-Za-z0-9\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F\u1E00-\u1EFF\u0300-\u036F+#]";
const PHRASE_SEPARATOR = "[[:space:]/._-]";
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const LEFT = `(?<!${WORD_CHARS})`;
const RIGHT = `(?!${WORD_CHARS})`;

/** Escape every Postgres ARE metacharacter; SQL always binds the resulting pattern as data. */
export function escapeSearchRegex(text: string): string {
  return text.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&");
}

/** A contiguous phrase within one field, never across non-separator scripts. */
export function searchPhrasePattern(words: readonly string[]): string {
  return LEFT + words.map((word, index) => {
    const separator = index === 0 ? "" : PHRASE_SEPARATOR + (CJK.test(words[index - 1]) || CJK.test(word) ? "*" : "+");
    return separator + escapeSearchRegex(word);
  }).join("") + RIGHT;
}

export function searchTermPattern(term: Pick<SearchTerm, "text" | "kind" | "match" | "words">): string {
  if (term.kind === "phrase") return searchPhrasePattern(term.words);
  const literal = escapeSearchRegex(term.text);
  if (term.kind === "cjk") return literal;
  return LEFT + literal + (term.match === "prefix" ? "" : RIGHT);
}

function textArray(values: readonly string[]): SQL {
  return sql`array[${sql.join(values.map((value) => sql`${value}`), sql`, `)}]::text[]`;
}

/**
 * The sole text-field predicate: storage-side NFKC, null safety, and a bound case-insensitive regex. The result equals
 * `normalize(coalesce(field, ''), NFKC) ~* pattern`, but normalize() (the dominant per-row cost on job descriptions) only
 * runs on text that is not NFKC-normalized already. ASCII text is always normalized and is recognized first, because
 * the IS NORMALIZED test itself costs a sizeable share of normalize().
 */
export function searchFieldMatches(field: SQL, pattern: string | readonly string[]): SQL {
  const value = sql`coalesce(${field}, '')`;
  const test = (text: SQL) => typeof pattern === "string" ? sql`${text} ~* ${pattern}` : sql`${text} ~* any(${textArray(pattern)})`;
  return sql`(case when octet_length(${value}) = char_length(${value}) or ${value} is nfkc normalized then ${test(value)} else ${test(sql`normalize(${value}, NFKC)`)} end)`;
}

function locations(): SQL {
  return sql`jsonb_array_elements(case when jsonb_typeof(${jobs.locationsJson}) = 'array' then ${jobs.locationsJson} else '[]'::jsonb end) as loc`;
}

/** Exact codes only; no inferred country from a city or free-text label. */
export function jobHasCountryIn(codes: readonly string[]): SQL {
  return sql`exists (select 1 from ${locations()} where jsonb_typeof(loc) = 'object' and upper(loc->>'countryCode') = any(${textArray(codes.map((code) => code.toUpperCase()))}))`;
}

function locationPatterns(term: SearchTerm): string[] {
  return (term.locationVariants.length ? term.locationVariants : [term.text]).map((text) => {
    const words = text.split(/\s+/u);
    if (words.length > 1) return searchPhrasePattern(words);
    const kind = CJK.test(text) ? "cjk" : /[+#.]/u.test(text) ? "symbol" : "word";
    return searchTermPattern({ text, words, kind, match: term.match });
  });
}

/** Each name, alias, city, label and translation is judged separately. No outer companies join is required. */
function termFields(term: SearchTerm, searchIn: SearchIn): Partial<Record<SearchField, SQL>> {
  if (term.countryOnly) return { country: jobHasCountryIn(term.countryCodes) };
  const pattern = searchTermPattern(term);
  const variants = locationPatterns(term);
  const fields: Partial<Record<SearchField, SQL>> = {
    title: searchFieldMatches(sql`${jobs.title}`, pattern),
    company: sql`exists (select 1 from companies c where c.id = ${jobs.companyId} and (
      ${searchFieldMatches(sql`c.name`, pattern)} or exists (select 1 from unnest(c.aliases) as a where ${searchFieldMatches(sql`a`, pattern)})
    ))`,
    location: sql`exists (select 1 from ${locations()} where jsonb_typeof(loc) = 'object' and (
      ${searchFieldMatches(sql`loc->>'city'`, variants)} or ${searchFieldMatches(sql`loc->>'label'`, variants)}
    ))`,
  };
  if (term.countryCodes.length) fields.country = jobHasCountryIn(term.countryCodes);
  if (searchIn === "all") {
    fields.description = searchFieldMatches(sql`${jobs.description}`, pattern);
    // `offset 0` keeps the marker-free text a computed column: inlined, regexp_replace would run once per use in the predicate.
    fields.translation = sql`exists (select 1 from translations t
      cross join lateral (select regexp_replace(t.content, ${STORED_MARKER_PATTERN}, '', 'g') as content offset 0) plain
      where t.job_id = ${jobs.id} and t.source_hash = ${descriptionHashSql}
      and ${searchFieldMatches(sql`plain.content`, pattern)})`;
  }
  return fields;
}

export function jobSearchCondition(plan: SearchPlan | null | undefined, searchIn: SearchIn | null = null): SQL | undefined {
  if (!plan || plan.status === "none") return undefined;
  if (plan.status === "no_terms") return sql`false`;
  return and(...plan.terms.map((term) => or(...Object.values(termFields(term, searchIn ?? "summary")))));
}

/** Optional title phrase, summary completeness and weight sum; the caller appends stable rank/date/id keys. */
export function jobSearchOrderBy(plan: SearchPlan, searchIn: SearchIn | null = null): SQL[] {
  if (plan.status !== "ok") return [];
  const titlePhrase = plan.phrase === null ? [] : [desc(searchFieldMatches(sql`${jobs.title}`, searchPhrasePattern(plan.phrase.split(" "))))];
  const summaryComplete = and(...plan.terms.map((term) => or(...Object.values(termFields(term, "summary"))))) ?? sql`false`;
  const contributions = plan.terms.map((term) => {
    const fields = termFields(term, searchIn ?? "summary");
    const weighted = Object.entries(fields).map(([field, condition]) => {
      const key = field as SearchField;
      const weight = plan.ranking.weights[key] * (key !== "country" && term.match === "prefix" ? plan.ranking.prefixFactor : 1);
      return sql`case when ${condition} then ${weight}::numeric else 0 end`;
    });
    return sql`greatest(0, ${sql.join(weighted, sql`, `)})`;
  });
  const relevance = contributions.length ? sql`(${sql.join(contributions, sql` + `)})` : sql`0`;
  return [...titlePhrase, desc(summaryComplete), desc(relevance)];
}

export interface JobCountryOption {
  code: string;
  jobCount: number;
}

/** One group-by for the chosen scope, counting each job once per code. Retain absent selections with count zero. */
export async function listJobCountryOptions(db: Db, options: { scope?: JobScope | null; selected?: readonly string[]; timezone: string }): Promise<JobCountryOption[]> {
  const latest = latestScoreCte(db);
  const ux = await uxTablesReady(db);
  const code = sql<string>`upper(loc->>'countryCode')`;
  const rows = await db.with(latest).select({ code, jobCount: sql<number>`count(distinct ${jobs.id})`.mapWith(Number) })
    .from(jobs)
    .leftJoin(latest, eq(latest.jobId, jobs.id))
    .innerJoin(sql`lateral ${locations()}`, sql`true`)
    .where(and(await jobListWhere(db, { scope: options.scope }, options.timezone, latest, ux), sql`jsonb_typeof(loc) = 'object'`, sql`${code} ~ '^[A-Z]{2}$'`))
    .groupBy(code)
    .orderBy(code);
  const counts = new Map(rows.map((row) => [row.code, row.jobCount]));
  for (const selected of options.selected ?? []) if (!counts.has(selected.toUpperCase())) counts.set(selected.toUpperCase(), 0);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([code, jobCount]) => ({ code, jobCount }));
}
