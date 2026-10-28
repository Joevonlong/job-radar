import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, expect, inject, it } from "vitest";

import * as schema from "@/lib/db/schema";
import { listJobsToScan, listJobsToSyncSalary } from "@/lib/db/repos/signals";
import { listJobsToTrapScan } from "@/lib/db/repos/traps";
import { listJobsToGhostCheck } from "@/lib/db/repos/ghost";
import { listJobsToVisaScan } from "@/lib/db/repos/visa";
import { listFilterCandidates } from "@/lib/db/repos/filter-results";

import { oldListFilterCandidates, oldListJobsToGhostCheck, oldListJobsToScan, oldListJobsToSyncSalary, oldListJobsToTrapScan, oldListJobsToVisaScan } from "./performance-baseline";

const client = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
afterAll(() => client.end());

it("preserves every change-detection relation for missing, current and changed scans, explicit scopes and limits", async () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const [company] = await db.insert(schema.companies).values({ name: "Example", nameNorm: "example", aliases: ["Other name"] }).returning();
  const jobs = await db.insert(schema.jobs).values(["Unicode 中文", "Changed JD", "", null, "   ", "Closed JD", "Dormant JD"].map((description, i) => ({
    companyId: company!.id, title: "Engineer", titleNorm: "engineer", description,
    status: i === 5 ? "closed" as const : i === 6 ? "possibly_closed" as const : "active" as const,
    firstSeenAt: now, lastSeenAt: new Date("2026-01-01T00:00:00Z"), dormantAt: i === 6 ? now : null,
  }))).returning();
  await db.insert(schema.channels).values({ id: "fixture", family: "fixture", kind: "manual" });
  for (const [i, j] of jobs.entries()) {
    if (i % 3 === 0) continue; // Jobs with no sources use md5(''), like the old outer join.
    const raws = await db.insert(schema.rawPostings).values([null, "canonical-sha256"].map((payloadHash, k) => ({ channelId: "fixture", externalId: `${i}-${k}`, payloadJson: { html: "<p>JD</p>", i }, payloadHash }))).returning();
    await db.insert(schema.jobSources).values(raws.map((raw) => ({ jobId: j.id, rawPostingId: raw.id, channelId: "fixture", priority: 100, firstSeenAt: now })));
  }
  const ids = jobs.map((j) => j.id);
  const ghost = { rulesHash: "rules", trustedKeys: ["example"], payloadChannels: ["fixture"], withTrapSpans: true, now, limit: 50 };
  const visa = { rulesHash: "rules", withTrapSpans: true, limit: 50 };
  async function compare() {
    for (const limit of [1, 50]) {
      for (const rulesHash of ["rules", "other"]) {
        const options = { rulesHash, afterId: 0, limit };
        expect(await listJobsToScan(db, options)).toEqual(await oldListJobsToScan(db, options));
        expect(await listJobsToSyncSalary(db, options)).toEqual(await oldListJobsToSyncSalary(db, options));
        for (const scope of [{}, { jobIds: ids }, { jobIds: ids, force: true }, { jobIds: [] }]) {
          expect(await listJobsToTrapScan(db, { ...options, ...scope })).toEqual(await oldListJobsToTrapScan(db, { ...options, ...scope }));
          expect(await listJobsToGhostCheck(db, { ...ghost, ...options, ...scope })).toEqual(await oldListJobsToGhostCheck(db, { ...ghost, ...options, ...scope }));
          expect(await listJobsToVisaScan(db, { ...visa, ...options, ...scope })).toEqual(await oldListJobsToVisaScan(db, { ...visa, ...options, ...scope }));
        }
      }
      for (const scope of [{}, { jobIds: ids }, { jobIds: [] }]) {
        const actual = await listFilterCandidates(db, { afterId: 0, limit, ...scope });
        expect(actual.map(({ inputHash, filterOverride, ...row }) => { void [inputHash, filterOverride]; return row; })).toEqual(await oldListFilterCandidates(db, { afterId: 0, limit, ...scope }));
      }
    }
  }
  expect((await listJobsToScan(db, { rulesHash: "rules", afterId: 0, limit: 50 })).length).toBeGreaterThan(0);
  await compare();
  for (const j of jobs) await db.insert(schema.signalScans).values({ jobId: j.id, descriptionHash: j.descriptionMd5!, salaryHash: j.salaryMd5, rulesHash: "rules", candidateCount: 0 });
  for (const j of await oldListJobsToTrapScan(db, { rulesHash: "rules", limit: 50, jobIds: ids, force: true })) {
    await db.insert(schema.trapScans).values({ jobId: j.jobId, descriptionHash: j.descriptionHash, sourcesHash: j.sourcesHash, rulesHash: "rules", spansHash: "spans" });
  }
  for (const j of await oldListJobsToGhostCheck(db, { ...ghost, jobIds: ids, force: true })) await db.insert(schema.jobGhost).values({ jobId: j.jobId, level: "none", score: 0, evidence: [], inputHash: j.inputHash });
  for (const j of await oldListJobsToVisaScan(db, { ...visa, jobIds: ids, force: true })) await db.insert(schema.jobVisa).values({ jobId: j.jobId, status: "not_mentioned", evidence: [], inputHash: j.inputHash });
  await compare();
  await db.update(schema.jobs).set({ description: "New text", salaryJson: { currency: "EUR", min: 1 } }).where(eq(schema.jobs.id, jobs[0]!.id));
  await db.update(schema.jobs).set({ salaryJson: { currency: "USD", max: 3 } }).where(eq(schema.jobs.id, jobs[1]!.id));
  await db.update(schema.rawPostings).set({ payloadJson: { html: "Changed legacy payload" } });
  await db.update(schema.companies).set({ nameNorm: "renamed", watched: true, blacklisted: true });
  await db.update(schema.trapScans).set({ spansHash: "other-spans" });
  await db.update(schema.jobGhost).set({ recheckAt: now });
  await db.delete(schema.jobSources).where(eq(schema.jobSources.jobId, jobs[1]!.id));
  await compare();
  // Rows that predate the migration remain correct without a blocking backfill.
  await db.update(schema.jobs).set({ descriptionMd5: null, descriptionHasText: null, salaryMd5: null });
  await db.update(schema.rawPostings).set({ payloadFingerprint: null });
  await compare();
});
