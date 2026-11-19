import { drizzle } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import { syncSelection } from "@/lib/capabilities/sync/scope";
import { expandAgentChangeKeys, indexSyncSalaryCandidates } from "@/lib/db/repos/agent-change-keys";
import type { AgentChangeRow } from "@/lib/db/repos/agent-changes";
import * as schema from "@/lib/db/schema";
import { SYNC_BLOCKS, SYNC_REMOVED_BITS, type SyncBlock } from "@/lib/db/sync-sources";
import { compileFamilies } from "@/lib/salary/families";
import { salaryLookupKey } from "@/lib/salary/lookup-key";

const families = compileFamilies([
  { id: "data", label: { en: "Data" }, patterns: ["data engineer"] },
  { id: "engineering", label: { en: "Engineering" }, patterns: ["engineer"] },
]);
const job = {
  id: 1, application: false, favorite: false,
  title: "Data Engineer", titleNorm: "data engineer", companyNorm: "Café | Tools", seniority: "Senior",
  location: { label: "Example City", city: "Example City", countryCode: "gb", isPrimary: true },
};
const jobIds = (candidates: readonly { id: number }[]) => candidates.map(({ id }) => id);
const bit = (block: SyncBlock) => 1 << SYNC_BLOCKS[block].bit;
const change = (fields: Pick<AgentChangeRow, "keyKind" | "key" | "blocks"> & { removed?: number }): AgentChangeRow => ({
  tx: "1", seq: "1", at: new Date(0), removed: 0, ...fields,
});

function queryFixture(rows: unknown[][]) {
  const db = drizzle.mock({ schema });
  const query = vi.fn<(sql: string, params: unknown[]) => { values: () => Promise<unknown[][]> }>();
  query.mockReturnValue({ values: async () => rows });
  Object.assign(db.$client, { unsafe: query });
  return { db, query };
}

describe("shared salary change keys", () => {
  it("matches only the same normalized company, family, title, seniority and first location", () => {
    const index = indexSyncSalaryCandidates([
      job,
      { ...job, id: 2, companyNorm: "cafe tools" },
      { ...job, id: 3, companyNorm: "other company" },
      { ...job, id: 4, title: "Support Engineer" },
      { ...job, id: 5, location: null },
      { ...job, id: 6, seniority: "junior" },
      { ...job, id: 7, titleNorm: "lead data engineer" },
    ], families, "GBP");
    expect(jobIds(index.lookup(salaryLookupKey(job, "data")))).toEqual([1, 2]);
  });

  it("uses the full hashed key when company prefixes are the same", () => {
    const long = { ...job, companyNorm: "x".repeat(450) };
    const similar = { ...job, id: 2, companyNorm: "x".repeat(449) + "y" };
    const index = indexSyncSalaryCandidates([long, similar], families, "GBP");
    expect(jobIds(index.lookup(salaryLookupKey(long, "data")))).toEqual([1]);
    expect(jobIds(index.lookup(salaryLookupKey(similar, "data")))).toEqual([2]);
  });

  it("matches every benchmark fallback with the current family and currency", () => {
    const index = indexSyncSalaryCandidates([
      job,
      { ...job, id: 2, seniority: "unknown" },
      { ...job, id: 3, location: null },
      { ...job, id: 4, seniority: "*" },
    ], families, "GBP");
    expect(jobIds(index.benchmark(["data", "senior", "city", "example city", "GBP"]))).toEqual([1]);
    expect(jobIds(index.benchmark(["data", "senior", "country", "GB", "GBP"]))).toEqual([1]);
    expect(jobIds(index.benchmark(["data", "*", "country", "GB", "GBP"]))).toEqual([1, 2, 4]);
    expect(jobIds(index.benchmark(["data", "*", "all", "*", "GBP"]))).toEqual([1, 2, 3, 4]);
    expect(index.benchmark(["engineering", "*", "all", "*", "GBP"])).toEqual([]);
    expect(index.benchmark(["former-family", "*", "all", "*", "GBP"])).toEqual([]);
    expect(index.benchmark(["data", "*", "all", "*", "EUR"])).toEqual([]);
  });

  it("reads salary candidates once across shared rows and resumes within the matched jobs", async () => {
    const { db, query } = queryFixture([1, 2].map((id) => [
      id, job.title, job.titleNorm, job.seniority, job.companyNorm, job.location, false, false,
    ]));
    const selection = syncSelection({
      tool: "list_job_changes", permission: "jobs:read", kinds: ["job"],
      blocks: ["job", "salary"], permissions: new Set(["jobs:read"]),
    });
    const scope = vi.fn(() => ({ families, currency: "GBP" }));
    const { prepareRows, expand } = expandAgentChangeKeys(db, 2, selection, scope);
    const lookup = change({ keyKind: "salary_key", key: salaryLookupKey(job, "data"), blocks: bit("salary") });
    const benchmark = change({ keyKind: "benchmark", key: '["data", "senior", "city", "example city", "GBP"]', blocks: bit("salary") });
    await prepareRows([lookup]);
    expect(query).not.toHaveBeenCalled();
    expect(scope).not.toHaveBeenCalled();

    const first = { jobId: 1, kind: "job" } as const;
    const second = { jobId: 2, kind: "job" } as const;
    expect(await Array.fromAsync(expand(lookup, null))).toEqual([first, second]);
    await prepareRows([benchmark]);
    expect(await Array.fromAsync(expand(benchmark, first))).toEqual([second]);
    expect(scope).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledOnce();
  });
});

it("batches direct tracking membership while retaining removals from the log", async () => {
  const { db, query } = queryFixture([[1, true, true], [2, false, true]]);
  const selection = syncSelection({
    tool: "list_application_changes", permission: "tracking:read", kinds: ["application", "favorite"],
    blocks: ["app", "fav"], permissions: new Set(["tracking:read"]),
  });
  const { prepareRows, expand } = expandAgentChangeKeys(db, 5, selection, () => null);
  const app = change({ keyKind: "job", key: "1", blocks: bit("app") });
  const favorite = change({ keyKind: "job", key: "2", blocks: bit("fav") });
  const unrelatedKind = change({ keyKind: "job", key: "2", blocks: bit("app") });
  const removal = change({ keyKind: "job", key: "3", blocks: bit("fav"), removed: 1 << SYNC_REMOVED_BITS.favorite });
  await prepareRows([app, favorite, unrelatedKind, removal]);

  expect(query).toHaveBeenCalledOnce();
  expect(query.mock.calls[0]?.[1]).toEqual([1, 2]);
  expect(await Array.fromAsync(expand(app, null))).toEqual([{ jobId: 1, kind: "application" }]);
  expect(await Array.fromAsync(expand(favorite, null))).toEqual([{ jobId: 2, kind: "favorite" }]);
  expect(await Array.fromAsync(expand(unrelatedKind, null))).toEqual([]);
  expect(await Array.fromAsync(expand(removal, null))).toEqual([{ jobId: 3, kind: "favorite" }]);
  expect(query).toHaveBeenCalledOnce();
});
