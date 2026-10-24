import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import type { PipelineConfig } from "@/lib/config";
import type { SavedView } from "@/lib/config/schemas/interests";
import {
  closeDb,
  countJobList,
  countTodayJobs,
  getDb,
  getOrCreateCompany,
  getViewDailyCounts,
  listCompanyFilterOptions,
  listJobs,
  listTodayJobs,
  schema,
  type HighValuePolicy,
  type JobFilters,
} from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { viewTrendInput } from "@/lib/interests/view-trends";
import { resolveViewCompanyIds } from "@/lib/jobs/job-filters";
import { resolveCompanyName } from "@/lib/pipeline/company";

import { pipelineWith } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const TZ = "Europe/Berlin";
const NOW = new Date("2026-10-07T12:00:00Z");
const SEEN = new Date("2026-10-07T09:00:00Z");

const withAliases = (aliases: Record<string, string[]>): PipelineConfig =>
  pipelineWith((raw) => {
    const company = raw.company as { aliases: Record<string, string[]>; legal_suffixes: string[] };
    company.aliases = aliases;
    company.legal_suffixes = ["gmbh", "ag", "se", "inc"];
  });

const plain = withAliases({});

interface JobInput {
  title: string;
  city?: string;
  status?: "active" | "possibly_closed" | "closed";
  /** Newest last; none = not scored yet. */
  scores?: Array<{ filterResult: "passed" | "filtered_out"; rankValue?: number }>;
  override?: "closed" | "open";
}

/** A company the way the pipeline stores it from a posting's company name under `config`. */
async function addCompany(rawName: string, config: PipelineConfig = plain): Promise<number> {
  const resolved = resolveCompanyName(rawName, config);
  return (await getOrCreateCompany(getDb(), resolved)).id;
}

async function addJob(companyId: number, input: JobInput): Promise<number> {
  const db = getDb();
  const [job] = await db
    .insert(schema.jobs)
    .values({
      companyId,
      title: input.title,
      titleNorm: input.title.toLowerCase(),
      locationsJson: input.city ? [{ city: input.city, country: "DE" }] : [],
      status: input.status ?? "active",
      firstSeenAt: SEEN,
      lastSeenAt: SEEN,
    })
    .returning({ id: schema.jobs.id });
  const id = job!.id;
  for (const [index, score] of (input.scores ?? []).entries()) {
    await db.insert(schema.scores).values({ jobId: id, filterResult: score.filterResult, rankValue: score.rankValue ?? null, createdAt: new Date(SEEN.getTime() + index * 60_000) });
  }
  if (input.override) await db.insert(schema.jobClosureOverrides).values({ jobId: id, action: input.override });
  return id;
}

const sorted = (values: number[]) => [...values].sort((a, b) => a - b);
const listed = async (filters: JobFilters) => sorted((await listJobs(getDb(), { filters, sort: "first_seen", page: 1, pageSize: 100, timezone: TZ })).jobs.map((job) => job.id));
const companyIds = async (names: string[], config = plain) => (await resolveViewCompanyIds(getDb(), [{ company: names }], { pipeline: config }))[0] ?? null;

let ids: Record<string, number> = {};

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  const sap = await addCompany("SAP SE");
  const fioneer = await addCompany("SAP Fioneer GmbH");
  ids = {
    sap,
    fioneer,
    sapBerlin: await addJob(sap, { title: "SAP Berlin", city: "Berlin", scores: [{ filterResult: "filtered_out" }, { filterResult: "passed", rankValue: 80 }] }),
    sapMunich: await addJob(sap, { title: "SAP München", city: "München", scores: [{ filterResult: "passed", rankValue: 50 }] }),
    sapUnscored: await addJob(sap, { title: "SAP unscored", city: "Berlin" }),
    sapPossibly: await addJob(sap, { title: "SAP possibly closed", status: "possibly_closed", scores: [{ filterResult: "passed", rankValue: 40 }] }),
    sapClosed: await addJob(sap, { title: "SAP closed", status: "closed", scores: [{ filterResult: "passed", rankValue: 70 }] }),
    sapReopened: await addJob(sap, { title: "SAP reopened", city: "Hamburg", status: "closed", override: "open", scores: [{ filterResult: "passed", rankValue: 60 }] }),
    sapClosedByHand: await addJob(sap, { title: "SAP closed by hand", override: "closed" }),
    sapFiltered: await addJob(sap, { title: "SAP filtered", scores: [{ filterResult: "passed", rankValue: 90 }, { filterResult: "filtered_out" }] }),
    fioneerJob: await addJob(fioneer, { title: "Fioneer", city: "Berlin" }),
  };
});

afterAll(async () => {
  await closeDb();
});

describe("company filter on /jobs", () => {
  const sapVisible = () => sorted([ids.sapBerlin!, ids.sapMunich!, ids.sapUnscored!, ids.sapPossibly!, ids.sapReopened!]);

  it("matches the key, the display name ignoring case, never a substring", async () => {
    expect(await companyIds(["SAP"])).toEqual([ids.sap]);
    expect(await companyIds(["sap se"])).toEqual([ids.sap]);
    expect(await companyIds(["SAP SE"])).toEqual([ids.sap]);
    expect(await companyIds(["Fioneer"])).toEqual([]);
    expect(await listed({ companyIds: await companyIds(["SAP"]) })).toEqual(sapVisible());
  });

  it("matches a stored alias (the raw spelling) once normalized, also after the alias left the config", async () => {
    const acme = await addCompany("Legacy Corp GmbH", withAliases({ Acme: ["Legacy Corp GmbH"] }));
    const job = await addJob(acme, { title: "Legacy" });
    expect(await companyIds(["Legacy Corp"])).toEqual([acme]);
    expect(await companyIds(["Acme"])).toEqual([acme]);
    expect(await listed({ companyIds: await companyIds(["legacy corp gmbh"]) })).toEqual([job]);
  });

  it("an alias added to the config after the row was stored still finds the row from its display name", async () => {
    const old = await addCompany("Oldbrand");
    const job = await addJob(old, { title: "Old" });
    const after = withAliases({ Newbrand: ["Oldbrand"] });
    expect(await companyIds(["Oldbrand"], after)).toEqual([old]);
    expect(await listed({ companyIds: await companyIds(["Oldbrand"], after) })).toEqual([job]);
  });

  it("several companies are an OR; with city, score and status it is an AND", async () => {
    const both = await companyIds(["SAP", "SAP Fioneer"]);
    expect(await listed({ companyIds: both })).toEqual(sorted([...sapVisible(), ids.fioneerJob!]));
    const sap = await companyIds(["SAP"]);
    expect(await listed({ companyIds: sap, cities: ["Berlin"] })).toEqual(sorted([ids.sapBerlin!, ids.sapUnscored!]));
    expect(await listed({ companyIds: sap, minRank: 60 })).toEqual(sorted([ids.sapBerlin!, ids.sapReopened!]));
    expect(await listed({ companyIds: sap, statuses: ["possibly_closed"] })).toEqual([ids.sapPossibly]);
    expect(await listed({ companyIds: both, cities: ["Berlin"], statuses: ["active"] })).toEqual(sorted([ids.sapBerlin!, ids.sapUnscored!, ids.fioneerJob!]));
  });

  it("a company that picks nothing gives an empty list without error; no company is no filter", async () => {
    const none = await companyIds(["Nobody"]);
    expect(none).toEqual([]);
    expect(await listed({ companyIds: none })).toEqual([]);
    expect(await countJobList(getDb(), { filters: { companyIds: none }, timezone: TZ })).toBe(0);
    expect(await companyIds([])).toBeNull();
    expect(await listed({ companyIds: null })).toEqual(await listed({}));
  });
});

describe("company drop-down options", () => {
  it("count the /jobs list as it opens (unscored, possibly closed, reopened in; closed and hard-filtered out), most jobs first", async () => {
    const options = await listCompanyFilterOptions(getDb(), { limit: 10, timezone: TZ });
    expect(options).toEqual([
      { name: "SAP SE", jobCount: 5 },
      { name: "SAP Fioneer GmbH", jobCount: 1 },
    ]);
    for (const option of options) {
      const total = await countJobList(getDb(), { filters: { companyIds: await companyIds([option.name]) }, timezone: TZ });
      expect(total).toBe(option.jobCount);
    }
  });

  it("are limited, and leave out companies without a listed job", async () => {
    expect(await listCompanyFilterOptions(getDb(), { limit: 1, timezone: TZ })).toEqual([{ name: "SAP SE", jobCount: 5 }]);
    const closedOnly = await addCompany("Closed Co");
    await addJob(closedOnly, { title: "Gone", status: "closed" });
    expect((await listCompanyFilterOptions(getDb(), { limit: 10, timezone: TZ })).map((option) => option.name)).not.toContain("Closed Co");
  });

  it("two rows of one company (not merged): each option counts its own row, the filter shows both", async () => {
    const after = withAliases({ Newbrand: ["Oldbrand"] });
    const old = await addCompany("Oldbrand");
    const fresh = await addCompany("Oldbrand", after);
    expect(fresh).not.toBe(old);
    const oldJob = await addJob(old, { title: "Old row" });
    const freshJob = await addJob(fresh, { title: "New row" });

    const options = await listCompanyFilterOptions(getDb(), { limit: 10, timezone: TZ });
    expect(options).toEqual(expect.arrayContaining([{ name: "Oldbrand", jobCount: 1 }, { name: "Newbrand", jobCount: 1 }]));
    // the old name now also means the new company: the link of the old row lists both rows' jobs
    expect(await listed({ companyIds: await companyIds(["Oldbrand"], after) })).toEqual(sorted([oldJob, freshJob]));
    expect(await listed({ companyIds: await companyIds(["Newbrand"], after) })).toEqual([freshJob]);
  });
});

describe("company filter on Today and the view trends", () => {
  const policy: HighValuePolicy = { amountId: null, amountHighValue: false, otherIds: [], minAnnualEur: null, rates: {}, otherRegionPoints: 0 };
  const view = (filters: SavedView["filters"]): SavedView => ({ id: "sap", name: "SAP", filters }) as SavedView;

  it("Today's list and count keep only the picked companies", async () => {
    const extra = { companyIds: await companyIds(["SAP"]) };
    const cards = await listTodayJobs(getDb(), { now: NOW, timezone: TZ, extra });
    expect(sorted(cards.map((card) => card.id))).toEqual(sorted([ids.sapBerlin!, ids.sapMunich!, ids.sapUnscored!, ids.sapPossibly!, ids.sapReopened!]));
    expect(await countTodayJobs(getDb(), { now: NOW, timezone: TZ, extra })).toBe(cards.length);
    expect(await listTodayJobs(getDb(), { now: NOW, timezone: TZ, extra: { companyIds: [] } })).toEqual([]);
  });

  it("a view's trend counts only its companies (the trend keeps closed jobs, Today hides them: unchanged here)", async () => {
    const sap = view({ company: ["SAP"] });
    const input = viewTrendInput(sap, { cityGroups: null, hideGermanLevels: [], highValue: policy, companyIds: await companyIds(["SAP"]) });
    expect(input.filters.companyIds).toEqual([ids.sap]);
    const nobody = viewTrendInput({ ...sap, id: "nobody" }, { cityGroups: null, hideGermanLevels: [], highValue: policy, companyIds: [] });
    const counts = await getViewDailyCounts(getDb(), { views: [input, nobody], timezone: TZ, now: NOW, days: 2 });
    // every SAP job but the hard-filtered one: the closed ones too
    expect(counts.get("sap")).toEqual([0, 7]);
    expect(counts.get("nobody")).toEqual([0, 0]);
  });
});
