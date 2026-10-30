import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, countJobList, countJobListSeen, countTodayJobs, getDb, getViewDailyCounts, listCompanyFilterOptions, listJobCountryOptions, listJobs, listTodayJobs, listUnseenJobIds, schema, SearchTimeoutError, type JobFilters } from "@/lib/db";
import { searchFieldMatches, searchPhrasePattern, searchTermPattern } from "@/lib/db/queries/job-search";
import { descriptionHash } from "@/lib/translation/hash";

import { searchPlan } from "../fixtures/job-search";

const timezone = "UTC";
const now = new Date("2026-10-07T12:00:00Z");
const ids = new Map<string, number>();
interface Seed { title: string; company?: string; city?: string; label?: string; code?: string; description?: string }
// Keep the compatibility and combining characters in storage exactly as supplied by the acceptance fixture.
const seed: Seed[] = [
  { title: "AI Engineer", company: "Quillfeather Labs", city: "Berlin", code: "DE" },
  { title: "Maintenance Technician", company: "Airbus", city: "Hamburg", code: "DE", description: "AI tooling" },
  { title: "Senior C++ Developer", city: "Munich", code: "DE", description: "C++ and Rust" },
  { title: "C# Engineer", city: "Wien", code: "AT" },
  { title: "C Developer", city: "Lyon", code: "FR", description: "embedded C" },
  { title: "Product Manager", city: "Paris", code: "FR", description: "travel to Germany; Deutschlandticket" },
  { title: "Product Marketing Manager", city: "Berlin", code: "DE" },
  { title: "Chef de projet", city: "Paris", code: "FR" },
  { title: "AI工程师", city: "Shanghai", code: "CN" },
  { title: "IT Support", city: "Milano", code: "IT" },
  { title: "Data Analyst", label: "New York, United States" },
  { title: "Backend Engineer", city: "Köln", code: "DE" },
  { title: "Frontend Engineer", city: "Lille", code: "FR" },
  { title: "Backend Developer", city: "Lisboa", code: "PT" },
  { title: "AI Researcher", city: "Munich", label: "Munich, Germany", code: "DE" },
  { title: "Head of Product", city: "Berlin", code: "DE", description: "Manager-level role" },
  { title: "Platform Engineer", company: "ＡＩ Labs", city: "Zürich", code: "CH" },
  { title: "Data Scientist", label: "México City", code: "MX" },
  { title: "Product产品Manager", city: "Graz", code: "AT", description: "Product产品Manager" },
  { title: "AI Platform Lead", city: "Berlin", code: "DE" },
];

beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
afterAll(closeDb);
beforeEach(async () => {
  ids.clear();
  const db = getDb();
  for (const [index, row] of seed.entries()) {
    const [company] = await db.insert(schema.companies).values({ name: row.company ?? `Fixture Works ${index + 1}`, nameNorm: `fixture-${index + 1}` }).returning();
    const [job] = await db.insert(schema.jobs).values({
      companyId: company!.id, title: row.title, titleNorm: row.title.toLowerCase(), description: row.description ?? "Fixture duties",
      locationsJson: [{ city: row.city ?? null, label: row.label ?? row.city ?? "", countryCode: row.code ?? null, isPrimary: true }],
      firstSeenAt: now, lastSeenAt: now, postedAt: now, status: "active",
    }).returning();
    ids.set(`J${index + 1}`, job!.id);
    await withRebuiltCurrentScores(db, db.insert(schema.scores).values(index === 19
      ? { jobId: job!.id, filterResult: "filtered_out" }
      : { jobId: job!.id, filterResult: "passed", rankValue: 100 - index, score: 100 - index }));
    if ([11, 12, 18].includes(index)) await db.insert(schema.translations).values({
      jobId: job!.id, lang: "zh", sourceHash: index === 12 ? "stale" : descriptionHash(row.description ?? "Fixture duties"),
      content: index === 18 ? "Product产品Manager" : index === 12 ? "产品经理" : "[[T1]]产品经理[[/T1]]，负责[[T1]]AI[[/T1]]平台",
    });
  }
  await db.insert(schema.jobClosureOverrides).values({ jobId: id("J14"), action: "closed" });
});

function id(key: string): number {
  const value = ids.get(key);
  if (value === undefined) throw new Error(`missing seed ${key}`);
  return value;
}
const keys = (jobs: readonly { id: number }[]) => jobs.map((job) => [...ids].find(([, value]) => value === job.id)?.[0] ?? `extra:${job.id}`);
async function list(q: string, filters: JobFilters = {}, sort: "relevance" | "rank" = "relevance", page = 1, pageSize = 100, dir: "asc" | "desc" | null = null) {
  return listJobs(getDb(), { filters: { ...filters, search: searchPlan(q) }, sort, dir, page, pageSize, timezone, visa: false, ghost: false });
}
async function matching(q: string, filters: JobFilters = {}): Promise<string[]> { return keys((await list(q, filters)).jobs); }
async function set(q: string, expected: string[], filters: JobFilters = {}) {
  expect((await matching(q, filters)).sort(), `${q}/${filters.searchIn ?? "summary"}`).toEqual([...expected].sort());
}
const germany = ["J1", "J2", "J3", "J7", "J12", "J15", "J16"];

describe("precise job search acceptance", () => {
  it("matches short whole words, ordering title before company before description/translation", async () => {
    expect(await matching("AI")).toEqual(["J1", "J9", "J15", "J17"]);
    expect(await matching("AI", { searchIn: "all" })).toEqual(["J1", "J9", "J15", "J17", "J2", "J12"]);
  });

  it("normalizes stored full-width company names and decomposed accents, as well as the query", async () => {
    expect(await matching("ＡＩ")).toEqual(["J1", "J9", "J15", "J17"]);
    expect(await matching("México")).toEqual(["J18"]);
    const [stored] = await getDb().execute<{ name: string; label: string }>(sql`select (select name from companies where id = (select company_id from jobs where id = ${id("J17")})) as name, locations_json->0->>'label' as label from jobs where id = ${id("J18")}`);
    expect(stored).toEqual({ name: "ＡＩ Labs", label: "México City" });
  });

  it("never searches JSON keys or JSON primitive spellings", async () => {
    await set("de", germany);
    for (const q of ["primary", "countryCode", "true", "null", "label"]) await set(q, []);
  });

  it("recognizes country names and exact codes with the specified result sets", async () => {
    for (const q of ["Germany", "Deutschland", "德国", "DE", "de"]) await set(q, germany);
    await set('"de"', ["J8"]);
    for (const q of ["Chef de projet", "chef de projet"]) await set(q, ["J8"]);
    await set("engineer DE", ["J1", "J12"]);
    await set("engineer de", []);
    await set("United States", ["J11"]);
    await set("IT", ["J10"]);
    await set("", ["J10"], { countries: ["IT"] });
    for (const q of ["Germany", "Deutschland"]) await set(q, [...germany, "J6"], { searchIn: "all" });
    await set("Germany", germany, { searchIn: "all", countries: ["DE"] });
    await set("DE", germany, { searchIn: "all" });
  });

  it("lists scoped country counts and retains absent selections; archive PT selects only the manually closed job", async () => {
    const current = [{ code: "AT", jobCount: 2 }, { code: "CH", jobCount: 1 }, { code: "CN", jobCount: 1 }, { code: "DE", jobCount: 7 }, { code: "FR", jobCount: 4 }, { code: "IT", jobCount: 1 }, { code: "MX", jobCount: 1 }];
    expect(await listJobCountryOptions(getDb(), { scope: "current", timezone })).toEqual(current);
    expect(await listJobCountryOptions(getDb(), { scope: "archive", timezone })).toEqual([{ code: "PT", jobCount: 1 }]);
    expect(await listJobCountryOptions(getDb(), { scope: "all", timezone })).toEqual([...current, { code: "PT", jobCount: 1 }]);
    expect(await listJobCountryOptions(getDb(), { scope: "current", selected: ["PT"], timezone })).toEqual([...current, { code: "PT", jobCount: 0 }]);
    await set("", ["J14"], { scope: "archive", countries: ["PT"] });
    await set("", [], { scope: "current", countries: ["PT"] });
  });

  it("keeps programming symbols literal and C distinct from C++ and C# in both search scopes", async () => {
    for (const searchIn of ["summary", "all"] as const) {
      await set("C++", ["J3"], { searchIn });
      await set("C#", ["J4"], { searchIn });
      await set("C", ["J5"], { searchIn });
    }
  });

  it("ANDs words across fields while keeping phrases contiguous inside a single field", async () => {
    expect(await matching("product manager")).toEqual(["J6", "J7", "J19"]);
    expect(await matching("product manager", { searchIn: "all" })).toEqual(["J6", "J7", "J19", "J16"]);
    for (const searchIn of ["summary", "all"] as const) {
      await set('"product manager"', ["J6"], { searchIn });
      await set('"product manager', ["J6"], { searchIn });
    }
  });

  it("does not stitch a company name to its alias or two location values into a phrase", async () => {
    const db = getDb();
    await db.execute(sql`update companies set name = 'Product', aliases = array['Manager'] where id = (select company_id from jobs where id = ${id("J8")})`);
    await db.execute(sql`update jobs set locations_json = '[{"city":"Product"},{"label":"Manager"}]'::jsonb where id = ${id("J11")}`);
    await set('"product manager"', ["J6"], { searchIn: "all" });
    await set("product manager", ["J6", "J7", "J8", "J11", "J19"]);
    await db.execute(sql`update companies set aliases = array['Ａｌｉａｓ Labs'] where id = (select company_id from jobs where id = ${id("J1")})`);
    await set('"alias labs"', ["J1"]);
  });

  it("ignores malformed/non-array locations safely", async () => {
    const db = getDb();
    await db.execute(sql`update jobs set locations_json = '{"city":"Berlin","countryCode":"DE"}'::jsonb where id = ${id("J1")}`);
    await set("DE", ["J2", "J3", "J7", "J12", "J15", "J16"]);
    await set("AI", ["J1", "J9", "J15", "J17"]);
  });

  it("allows only sufficiently long word prefixes", async () => {
    await set("quillfeath", ["J1"]);
    await set("eng", []);
  });

  it("expands city aliases per term with a nonempty exact intersection", async () => {
    await set("AI München", ["J15"]);
    await set("AI Munich", ["J15"]);
  });

  it("searches JD-only words only in all scope", async () => {
    await set("Deutschlandticket", []);
    await set("Deutschlandticket", ["J6"], { searchIn: "all" });
  });

  it("searches only current complete translations without stored markers", async () => {
    await set("产品经理", []);
    await set("产品经理", ["J12"], { searchIn: "all" });
    await set("T1", [], { searchIn: "all" });
  });

  it("treats punctuation-only input as no matches rather than clearing search", async () => {
    for (const q of ["%", "+++", '"  "']) await set(q, []);
  });

  it("has stable relevance, no duplicate-term bonus, fixed descending direction, and a rank fallback without a plan", async () => {
    const expected = ["J1", "J9", "J15", "J17", "J2", "J12"];
    expect(await matching("AI AI", { searchIn: "all" })).toEqual(expected);
    expect(keys((await list("AI", { searchIn: "all" }, "relevance", 1, 100, "asc")).jobs)).toEqual(expected);
    expect([...keys((await list("AI", { searchIn: "all" }, "relevance", 1, 3)).jobs), ...keys((await list("AI", { searchIn: "all" }, "relevance", 2, 3)).jobs)]).toEqual(expected);
    const allCurrent = ["J1", "J2", "J3", "J4", "J5", "J6", "J7", "J8", "J9", "J10", "J11", "J12", "J13", "J15", "J16", "J17", "J18", "J19"];
    expect(await matching("")).toEqual(allCurrent);
    // Equal rank and times: id is the final tie-breaker.
    await getDb().execute(sql`update scores set rank_value = 50 where job_id in (${id("J1")}, ${id("J9")}, ${id("J15")})`);
    expect(await matching("AI")).toEqual(["J15", "J9", "J1", "J17"]);
  });

  it("mixes hard-filtered title hits by relevance, while rank still places them after every unfiltered hit", async () => {
    const filters = { searchIn: "all", includeFiltered: true } as const;
    expect(await matching("AI", filters)).toEqual(["J1", "J9", "J15", "J20", "J17", "J2", "J12"]);
    expect(keys((await list("AI", filters, "rank")).jobs)).toEqual(["J1", "J2", "J9", "J12", "J15", "J17", "J20"]);
  });

  it("keeps totals, seen counts, mark-all-seen ids and company option counts consistent without multiplying locations/translations", async () => {
    await getDb().update(schema.jobs).set({ locationsJson: [{ city: "Berlin", countryCode: "DE" }, { city: "Berlin", countryCode: "DE" }] }).where(sql`id = ${id("J1")}`);
    await getDb().insert(schema.translations).values({ jobId: id("J12"), lang: "de", sourceHash: descriptionHash("Fixture duties"), content: "AI Plattform" });
    const filters = { search: searchPlan("AI"), searchIn: "all" } as const;
    const expected = ["J1", "J9", "J15", "J17", "J2", "J12"];
    const options = await listCompanyFilterOptions(getDb(), { limit: 100, timezone });
    expect(await matching("AI", { searchIn: "all" })).toEqual(expected);
    expect((await list("AI", { searchIn: "all" })).total).toBe(expected.length);
    expect(await countJobList(getDb(), { filters, timezone })).toBe(expected.length);
    expect(await countJobListSeen(getDb(), { filters, timezone, since: null })).toEqual({ unseen: expected.length, newSince: 0 });
    expect((await listUnseenJobIds(getDb(), { filters, timezone })).sort((a, b) => a - b)).toEqual(expected.map(id).sort((a, b) => a - b));
    expect((await listJobCountryOptions(getDb(), { timezone })).find((row) => row.code === "DE")).toEqual({ code: "DE", jobCount: 7 });
    expect(await listCompanyFilterOptions(getDb(), { limit: 100, timezone })).toEqual(options);
  });

  it("Today saved-view company search has matching list/count without an outer companies join; trends also accept q", async () => {
    const extra = { search: searchPlan("quillfeath") };
    expect(keys(await listTodayJobs(getDb(), { now, timezone, extra, visa: false }))).toEqual(["J1"]);
    expect(await countTodayJobs(getDb(), { now, timezone, extra })).toBe(1);
    const trends = await getViewDailyCounts(getDb(), { views: [{ id: "company-search", filters: extra }], timezone, now, days: 1 });
    expect(trends.get("company-search")).toEqual([1]);
  });
});

describe("full-text search time limit", () => {
  it("cancels searchIn=all list and count queries past the limit and leaves summary search and the session untouched", async () => {
    // A few megabytes of description keep the regex scan well above one millisecond
    await getDb().execute(sql`update jobs set description = repeat('lorem ipsum dolor ', 200000) || 'AI tooling' where id = ${id("J2")}`);
    const search = { ...searchPlan("tooling"), allScopeTimeoutMs: 1 };
    const filters: JobFilters = { search, searchIn: "all" };
    await expect(listJobs(getDb(), { filters, sort: "relevance", page: 1, pageSize: 50, timezone })).rejects.toBeInstanceOf(SearchTimeoutError);
    await expect(countJobList(getDb(), { filters, timezone })).rejects.toBeInstanceOf(SearchTimeoutError);
    await expect(countJobListSeen(getDb(), { filters, timezone, since: null })).rejects.toBeInstanceOf(SearchTimeoutError);
    await expect(listUnseenJobIds(getDb(), { filters, timezone })).rejects.toBeInstanceOf(SearchTimeoutError);
    expect(keys((await listJobs(getDb(), { filters: { search }, sort: "relevance", page: 1, pageSize: 50, timezone })).jobs)).toEqual([]);
    // The limit is transaction-local: pooled sessions keep the server default afterwards
    const sessions = await Promise.all(Array.from({ length: 4 }, () => getDb().execute<{ timeout: string }>(sql`select current_setting('statement_timeout') as timeout`)));
    expect(sessions.map(([row]) => row?.timeout)).not.toContain("1ms");
    const generous = { search: { ...search, allScopeTimeoutMs: 60_000 }, searchIn: "all" } as const;
    expect(keys((await listJobs(getDb(), { filters: generous, sort: "relevance", page: 1, pageSize: 50, timezone })).jobs)).toEqual(["J2"]);
  });
});

describe("field predicate fast path", () => {
  // normalize() is skipped for ASCII and already-normalized text; the result must equal the plain NFKC predicate.
  const values: (string | null)[] = [
    null, "", "Senior AI Engineer", "Müller GmbH", "Mu\u0308ller GmbH", "ＡＩ Ｌａｂｓ", "\uFB01nance team", "AI² Labs", "AI2 Labs",
    "Zürich\u00A0Office", "Zu\u0308rich Office", "产品经理AI平台", "Ｃ＋＋ developer", "C++ developer", "Ⅸ Capital", "ix capital",
  ];
  const word = (text: string, match: "whole" | "prefix" = "whole") => searchTermPattern({ text, kind: "word", match, words: [text] });
  const patterns: (string | string[])[] = [
    word("ai"), word("ai2"), word("müller"), word("labs"), word("fina", "prefix"), word("ix"),
    searchTermPattern({ text: "c++", kind: "symbol", match: "whole", words: ["c++"] }),
    searchTermPattern({ text: "产品", kind: "cjk", match: "whole", words: ["产品"] }),
    searchPhrasePattern(["zürich", "office"]),
    [word("zurich"), word("zürich")],
  ];

  it("matches exactly like normalize(field, NFKC) for ASCII, accented, decomposed, full-width and compatibility text", async () => {
    let hits = 0;
    for (const value of values) for (const pattern of patterns) {
      const reference = typeof pattern === "string"
        ? sql`normalize(coalesce(${value}::text, ''), NFKC) ~* ${pattern}`
        : sql`normalize(coalesce(${value}::text, ''), NFKC) ~* any(array[${sql.join(pattern.map((p) => sql`${p}`), sql`, `)}]::text[])`;
      const [row] = await getDb().execute<{ fast: boolean; reference: boolean }>(sql`select ${searchFieldMatches(sql`${value}::text`, pattern)} as fast, ${reference} as reference`);
      expect(row!.fast, `${JSON.stringify(value)} ~ ${JSON.stringify(pattern)}`).toBe(row!.reference);
      if (row!.reference) hits += 1;
    }
    // not vacuous: decomposed, full-width, ligature and compatibility forms all reach the normalize() branch and match
    expect(hits).toBeGreaterThanOrEqual(15);
    const one = async (value: string, pattern: string) => (await getDb().execute<{ ok: boolean }>(sql`select ${searchFieldMatches(sql`${value}::text`, pattern)} as ok`))[0]!.ok;
    expect(await one("Mu\u0308ller GmbH", word("müller"))).toBe(true);
    expect(await one("ＡＩ Ｌａｂｓ", word("ai"))).toBe(true);
    expect(await one("\uFB01nance team", word("fina", "prefix"))).toBe(true);
    expect(await one("AI² Labs", word("ai"))).toBe(false);
    expect(await one("AI² Labs", word("ai2"))).toBe(true);
  });
});
