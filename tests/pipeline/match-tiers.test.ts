// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Executor } from "@/lib/db/executor";
import * as jobs from "@/lib/db/repos/jobs";
import { decideMatch, findMatchingJob, type MatchCandidate, type MatchInput, type MatchLoaders, type RelatedCandidate } from "@/lib/pipeline/dedupe";
import { normalizeDraft, normalizeTitle } from "@/lib/pipeline/normalize";

import { draft, pipelineWith } from "./helpers";

vi.mock("@/lib/db/repos/jobs", async (original) => ({
  ...(await original<typeof jobs>()),
  findJobByFamilyExternalId: vi.fn(),
  getJob: vi.fn(),
  listJobsByCompanyTitle: vi.fn(),
  listJobsOfOtherCompaniesByTitle: vi.fn(),
  listJobsWithSimhash: vi.fn(),
}));

type Guard = { enabled?: boolean; same_title_max_distance?: number; different_title_max_distance?: number | null };

const guarded = (guard: Guard = {}, dedupe: Record<string, unknown> = {}) =>
  pipelineWith((raw) => {
    Object.assign(raw.dedupe as object, { simhash_max_distance: 3, cross_company_simhash_max_distance: 14, ...dedupe, title_guard: { enabled: true, same_title_max_distance: 6, ...guard } });
  });

/** A 64-bit hash at exactly `distance` bits from `HASH`. */
const at = (distance: number): string => ((1n << BigInt(distance)) - 1n).toString(16).padStart(16, "0");
const HASH = at(0);

const BODY = "word ".repeat(40);
const inputOf = (title = "Data Engineer", where = "Berlin"): MatchInput => {
  const config = guarded();
  const normalized = normalizeDraft(draft({ title, locations: [{ label: where, city: where, countryCode: "DE" }], description: BODY }), config);
  return { normalized: { ...normalized, simhash: HASH }, companyId: 1, companyName: "Northwind Labs GmbH", channelFamily: "ats", externalId: "x1", rawPostingId: 100 };
};

const candidate = (id: number, title: string, distance: number): MatchCandidate => ({ id, title, titleNorm: normalizeTitle(title), simhash: at(distance), locations: [{ label: "Hamburg", city: "Hamburg", countryCode: "DE", isPrimary: true }] });
const related = (id: number, title: string, distance: number): RelatedCandidate => ({ ...candidate(id, title, distance), companyNameNorm: "northwind-labs-gmbh-holding" });

function loaders(over: Partial<MatchLoaders> = {}): MatchLoaders {
  return { sameSource: async () => null, byCompanyTitle: async () => [], sameCompanyWithHash: async () => [], relatedCompanyByTitle: async () => [], ...over };
}
const hashed = (...rows: MatchCandidate[]): Partial<MatchLoaders> => ({ sameCompanyWithHash: async () => rows });
const NONE: ReadonlySet<number> = new Set();

describe("the SimHash pass by title relation", () => {
  it.each([
    [6, 1],
    [7, null],
  ])("same title at distance %i merges up to the same-title limit", async (distance, expected) => {
    const { decision } = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Data Engineer", distance))), guarded(), NONE);
    expect(decision?.jobId ?? null).toBe(expected);
    if (decision) expect(decision.detail).toMatchObject({ rule: "simhash", title: "same", distance, limit: 6, comparedTitle: "Data Engineer" });
  });

  it.each([
    [3, 1],
    [4, null],
  ])("compatible title at distance %i merges up to simhash_max_distance", async (distance, expected) => {
    const { decision } = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Data Engineer (Remote)", distance))), guarded(), NONE);
    expect(decision?.jobId ?? null).toBe(expected);
    if (decision) expect(decision.detail).toMatchObject({ title: "compatible", limit: 3 });
  });

  it("never merges a different title at the null limit, at any distance", async () => {
    const result = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Staff Platform Engineer", 0))), guarded(), NONE);
    expect(result).toEqual({ decision: null, blockedByTitle: true });
  });

  it.each([
    [2, 1],
    [3, null],
  ])("different title at distance %i merges up to a numeric limit", async (distance, expected) => {
    const { decision } = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Staff Platform Engineer", distance))), guarded({ different_title_max_distance: 2 }), NONE);
    expect(decision?.jobId ?? null).toBe(expected);
  });

  it("takes the nearest candidate, then the lowest id", async () => {
    const nearest = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Data Engineer", 5), candidate(2, "Data Engineer", 2), candidate(3, "Data Engineer", 4))), guarded(), NONE);
    expect(nearest.decision?.jobId).toBe(2);
    const tie = await decideMatch(inputOf(), loaders(hashed(candidate(3, "Data Engineer", 2), candidate(2, "Data Engineer", 2))), guarded(), NONE);
    expect(tie.decision?.jobId).toBe(2);
  });

  it("leaves the first, second and fourth passes as they were", async () => {
    const config = guarded();
    const first = await decideMatch(inputOf(), loaders({ sameSource: async () => ({ id: 9 }), ...hashed(candidate(1, "Data Engineer", 0)) }), config, NONE);
    expect(first.decision).toMatchObject({ jobId: 9, rule: "same_source" });
    const second = await decideMatch(inputOf(), loaders({ byCompanyTitle: async () => [{ id: 8, locations: [{ label: "Berlin", city: "Berlin", countryCode: "DE", isPrimary: true }] }] }), config, NONE);
    expect(second.decision).toMatchObject({ jobId: 8, rule: "exact_key" });
    const otherCity = await decideMatch(inputOf(), loaders({ byCompanyTitle: async () => [{ id: 8, locations: [{ label: "Köln", city: "Köln", countryCode: "DE", isPrimary: true }] }] }), config, NONE);
    expect(otherCity.decision).toBeNull();
    const fourth = await decideMatch(inputOf(), loaders({ relatedCompanyByTitle: async () => [related(7, "Data Engineer", 14), related(6, "Data Engineer", 15)] }), config, NONE);
    expect(fourth.decision).toMatchObject({ jobId: 7, rule: "related_company", detail: { title: "same", distance: 14, limit: 14, comparedTitle: "Data Engineer" } });
  });
});

describe("counting a candidate held back by its title", () => {
  it("counts several held back candidates as one posting", async () => {
    const result = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Staff Platform Engineer", 0), candidate(2, "Product Designer", 1))), guarded(), NONE);
    expect(result.blockedByTitle).toBe(true);
  });

  it("does not count when another candidate merges, or the fourth pass does", async () => {
    const merged = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Staff Platform Engineer", 0), candidate(2, "Data Engineer", 1))), guarded(), NONE);
    expect(merged).toMatchObject({ decision: { jobId: 2 }, blockedByTitle: false });
    const fourth = await decideMatch(inputOf(), loaders({ ...hashed(candidate(1, "Staff Platform Engineer", 0)), relatedCompanyByTitle: async () => [related(7, "Data Engineer", 5)] }), guarded(), NONE);
    expect(fourth).toMatchObject({ decision: { jobId: 7 }, blockedByTitle: false });
  });

  it("does not count beyond what the old rule would have merged", async () => {
    const result = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Staff Platform Engineer", 4))), guarded(), NONE);
    expect(result.blockedByTitle).toBe(false);
  });

  it("never counts with the guard off", async () => {
    const result = await decideMatch(inputOf(), loaders(hashed(candidate(1, "Staff Platform Engineer", 4))), guarded({ enabled: false }), NONE);
    expect(result).toEqual({ decision: null, blockedByTitle: false });
  });
});

describe("with the guard off", () => {
  const off = guarded({ enabled: false });
  it.each([
    ["first within the limit, whatever its title", [candidate(5, "Staff Platform Engineer", 3), candidate(6, "Data Engineer", 0)], 5],
    ["skips one beyond the limit", [candidate(5, "Data Engineer", 4), candidate(6, "Product Designer", 3)], 6],
    ["same title gets no wider limit", [candidate(5, "Data Engineer", 4)], null],
    ["compatible gets the same limit", [candidate(5, "Data Engineer (Remote)", 3)], 5],
    ["a job without a hash is skipped", [{ ...candidate(5, "Data Engineer", 0), simhash: null }, candidate(6, "Data Engineer", 1)], 6],
  ])("%s", async (_name, rows, expected) => {
    const { decision } = await decideMatch(inputOf(), loaders(hashed(...rows)), off, NONE);
    expect(decision?.jobId ?? null).toBe(expected);
    if (decision) expect(decision.detail).toMatchObject({ title: null, limit: 3 });
  });
});

describe("a job that cannot be fetched any more", () => {
  const db = {} as Executor;
  const row = (id: number, title: string, distance: number) => ({ id, title, titleNorm: normalizeTitle(title), simhash: at(distance), locationsJson: [{ label: "Hamburg", city: "Hamburg", countryCode: "DE", isPrimary: true }] });
  const job = (id: number) => ({ id }) as jobs.Job;

  beforeEach(() => {
    vi.mocked(jobs.findJobByFamilyExternalId).mockReset().mockResolvedValue(null);
    vi.mocked(jobs.listJobsByCompanyTitle).mockReset().mockResolvedValue([]);
    vi.mocked(jobs.listJobsWithSimhash).mockReset().mockResolvedValue([]);
    vi.mocked(jobs.listJobsOfOtherCompaniesByTitle).mockReset().mockResolvedValue([]);
    vi.mocked(jobs.getJob).mockReset().mockResolvedValue(null);
  });

  const stubGone = (...gone: number[]): void => {
    vi.mocked(jobs.getJob).mockImplementation(async (_db, id) => (gone.includes(id) ? null : job(id)));
  };

  it("goes on to the next eligible candidate", async () => {
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([row(1, "Data Engineer", 1), row(2, "Data Engineer", 2)]);
    stubGone(1);
    const result = await findMatchingJob(db, inputOf(), guarded());
    expect(result.match?.job.id).toBe(2);
    expect(jobs.listJobsWithSimhash).toHaveBeenCalledTimes(1);
  });

  it("falls through to the fourth pass when none of the third pass is left", async () => {
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([row(1, "Data Engineer", 1)]);
    vi.mocked(jobs.listJobsOfOtherCompaniesByTitle).mockResolvedValue([{ ...row(3, "Data Engineer", 5), companyNameNorm: "northwind-labs-gmbh-holding" }]);
    stubGone(1);
    const result = await findMatchingJob(db, inputOf(), guarded());
    expect(result.match).toMatchObject({ job: { id: 3 }, kind: "simhash", detail: { rule: "related_company" } });
  });

  it("walks in id order with the guard off", async () => {
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([row(1, "Product Designer", 1), row(2, "Data Engineer", 3), row(3, "Data Engineer", 0)]);
    stubGone(1);
    const result = await findMatchingJob(db, inputOf(), guarded({ enabled: false }));
    expect(result.match?.job.id).toBe(2);
  });

  it("reports the last decision's held back candidate when all are gone", async () => {
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([row(1, "Data Engineer", 1), row(2, "Staff Platform Engineer", 0)]);
    stubGone(1);
    expect(await findMatchingJob(db, inputOf(), guarded())).toEqual({ match: null, blockedByTitle: true });
  });

  it("reads each list once in a call", async () => {
    vi.mocked(jobs.listJobsByCompanyTitle).mockResolvedValue([]);
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([row(1, "Data Engineer", 1), row(2, "Data Engineer", 2)]);
    vi.mocked(jobs.listJobsOfOtherCompaniesByTitle).mockResolvedValue([]);
    stubGone(1, 2);
    expect(await findMatchingJob(db, inputOf(), guarded())).toEqual({ match: null, blockedByTitle: false });
    expect(jobs.findJobByFamilyExternalId).toHaveBeenCalledTimes(1);
    expect(jobs.listJobsByCompanyTitle).toHaveBeenCalledTimes(1);
    expect(jobs.listJobsWithSimhash).toHaveBeenCalledTimes(1);
    expect(jobs.listJobsOfOtherCompaniesByTitle).toHaveBeenCalledTimes(1);
  });

  it("reads bad stored locations as none: no same city, no country of that side, only the table's cities", async () => {
    const bad = { ...row(1, "Data Engineer", 1), locationsJson: { city: 3 } };
    const badTitleRow = { ...row(2, "Data Engineer - Germany", 1), locationsJson: "nonsense" };
    const badOwnCity = { ...row(3, "Data Engineer - Kleinkleckersdorf", 1), locationsJson: [{ city: 7 }] };
    vi.mocked(jobs.listJobsByCompanyTitle).mockResolvedValue([{ ...job(1), locationsJson: { city: 3 } } as jobs.Job]);
    const exact = await findMatchingJob(db, inputOf(), guarded());
    expect(exact.match).toBeNull();
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([bad]);
    stubGone();
    expect((await findMatchingJob(db, inputOf(), guarded())).match?.detail).toMatchObject({ rule: "simhash", title: "same" });
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([badTitleRow]);
    expect(await findMatchingJob(db, inputOf(), guarded())).toEqual({ match: null, blockedByTitle: true });
    vi.mocked(jobs.listJobsWithSimhash).mockResolvedValue([badOwnCity]);
    expect(await findMatchingJob(db, inputOf(), guarded())).toEqual({ match: null, blockedByTitle: true });
  });
});

