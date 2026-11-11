import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, expect, inject, it, vi } from "vitest";

import * as schema from "@/lib/db/schema";
import { runFilter } from "@/lib/filter";

import { prefs } from "../filter/helpers";
import { shippedPipeline } from "../pipeline/helpers";

/** Set while a posting is read: the time box below stops the readings of postings titled "Slow". */
const reading = vi.hoisted(() => ({ slow: false }));
vi.mock("@/lib/filter/work-area", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/filter/work-area")>();
  return {
    ...actual,
    readWorkArea: (...args: Parameters<typeof actual.readWorkArea>) => {
      reading.slow = args[0].startsWith("Slow");
      return actual.readWorkArea(...args);
    },
  };
});

const client = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
afterAll(() => client.end());

/** Stops every reading of a "Slow" posting, and nothing else, whatever the machine's speed. */
const timeBox = (work: () => void): boolean => {
  reading.slow = false;
  work();
  return !reading.slow;
};

it.each([
  ["unchanged jobs are skipped", []],
  ["a phrase deal-breaker reads every job each run", [{ id: "never-matches", label: "Rule", type: "phrase" as const, patterns: ["never-matching-phrase"] }]],
])("a later posting gets its verdict by the second run when earlier postings always time out (%s)", async (_case, dealBreakers) => {
  const [company] = await db.insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  const postings = [
    { title: "Slow 1", description: "You must live in France." },
    { title: "Slow 2", description: "You must live in France." },
    { title: "Engineer", description: "You must live in France." },
  ];
  const rows = await db.insert(schema.jobs).values(postings.map((posting) => ({ ...posting, companyId: company!.id, titleNorm: posting.title.toLowerCase(), workplace: "remote" as const, contract: "permanent" }))).returning();
  const [snapshot] = await db.insert(schema.profileSnapshots).values({ kind: "preferences", hash: "work-area", contentYaml: "work-area" }).returning();
  const pipeline = structuredClone(shippedPipeline());
  pipeline.filter.remote.work_area.patterns = ["^You must live in (?<place>[^.]{2,60})"];
  pipeline.filter.deal_breakers.match_ms = 10;
  pipeline.filter.deal_breakers.rule_budget_ms = 20;
  const preferences = prefs((raw) => {
    raw.deal_breakers = dealBreakers;
  });
  const run = () => runFilter(db, { snapshotId: snapshot!.id, preferences, pipeline, me: null, watchedCompanies: [], timeBox });
  const verdicts = async () => {
    const stored = await db.select({ jobId: schema.scores.jobId, result: schema.scores.filterResult, reasons: schema.scores.filterReasons }).from(schema.scores).where(eq(schema.scores.profileSnapshotId, snapshot!.id)).orderBy(asc(schema.scores.jobId));
    return stored.map(({ result, reasons }) => ({ result, area: reasons.filter((reason) => /^remote_(out_of_scope|area_unknown)/.test(reason)) }));
  };
  expect(rows).toHaveLength(3);

  await run();
  const unknown = { result: "passed", area: ["remote_area_unknown"] };
  expect(await verdicts()).toEqual([unknown, unknown, unknown]);

  await run();
  expect(await verdicts()).toEqual([unknown, unknown, { result: "filtered_out", area: ["remote_out_of_scope:You must live in France"] }]);
});
