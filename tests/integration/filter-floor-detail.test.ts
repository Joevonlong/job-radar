import { withRebuiltCurrentScores } from "../helpers/current-scores";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { closeDb, getDb, getFilterFloors, getJobDetail, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { getOrCreateCompany } from "@/lib/db/repos/companies";
import { insertJob } from "@/lib/db/repos/jobs";
import { saveProfileSnapshot } from "@/lib/db/repos/profile-snapshots";

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
beforeEach(async () => {
  await getDb().execute(sql`truncate table jobs, companies, profile_snapshots restart identity cascade`);
});
afterAll(async () => {
  await getDb().execute(sql`truncate table jobs, companies, profile_snapshots restart identity cascade`);
  await closeDb();
});

async function filteredJob(reasons: string[], snapshotYaml: string | null): Promise<number> {
  const db = getDb();
  const company = await getOrCreateCompany(db, { name: "Acme", nameNorm: "acme" });
  const job = await insertJob(db, { companyId: company.id, title: "SRE", titleNorm: "sre" });
  const snapshot = snapshotYaml === null ? null : await saveProfileSnapshot(db, "preferences", snapshotYaml);
  await withRebuiltCurrentScores(db, db.insert(schema.scores).values({ jobId: job.id, profileSnapshotId: snapshot?.id ?? null, filterResult: "filtered_out", filterReasons: reasons }));
  return job.id;
}

describe("the salary floor a job was filtered under", () => {
  it("reads it from the preferences snapshot the filter result was made under", async () => {
    const id = await filteredJob(["salary_below_floor:58000"], "target_titles: [SRE]\nsalary_floor_year: 80000\n");
    expect((await getJobDetail(getDb(), id))?.score?.filterFloorEur).toBe(80000);
  });

  it("is null without a snapshot, with a snapshot that has no floor, and for a job the salary did not filter", async () => {
    expect((await getJobDetail(getDb(), await filteredJob(["salary_below_floor:58000"], null)))?.score?.filterFloorEur).toBeNull();
    expect((await getJobDetail(getDb(), await filteredJob(["salary_below_floor:58000"], "locations: [Berlin]\n")))?.score?.filterFloorEur).toBeNull();
    expect((await getJobDetail(getDb(), await filteredJob(["student_role"], "salary_floor_year: 80000\n")))?.score?.filterFloorEur).toBeNull();
  });
});

describe("the floor of the time for a page of list rows", () => {
  it("one lookup gives each job the floor of the snapshot its newest filter result was made under", async () => {
    const a = await filteredJob(["salary_below_floor:58000"], "salary_floor_year: 80000\n");
    const b = await filteredJob(["salary_below_floor:58000"], "salary_floor_year: 65000\n");
    const c = await filteredJob(["salary_below_floor:58000"], null);
    const floors = await getFilterFloors(getDb(), [a, b, c]);
    expect(floors.get(a)).toBe(80000);
    expect(floors.get(b)).toBe(65000);
    expect(floors.get(c)).toBeNull();
    expect((await getFilterFloors(getDb(), [])).size).toBe(0);
  });
});
