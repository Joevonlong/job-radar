import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { afterAll, expect, inject, it } from "vitest";

import { backfillChangeFingerprints } from "@/lib/db/repos/change-fingerprints";
import * as schema from "@/lib/db/schema";

const client = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
const other = postgres(inject("testDatabaseUrl"), { max: 1, onnotice: () => {} });
const db = drizzle(client, { schema });
afterAll(async () => { await client.end(); await other.end(); });

async function fixture() {
  const [company] = await db.insert(schema.companies).values({ name: "Example", nameNorm: "example" }).returning();
  const jobs = await db.insert(schema.jobs).values([null, "", "Unicode 中文"].map((description, i) => ({ companyId: company!.id, title: `Job ${i}`, titleNorm: `job ${i}`, description }))).returning();
  await db.insert(schema.channels).values({ id: "fixture", family: "fixture", kind: "manual" });
  await db.insert(schema.rawPostings).values([null, "canonical", null].map((payloadHash, i) => ({ channelId: "fixture", externalId: `${i}`, payloadJson: { text: `${i}` }, payloadHash })));
  return jobs;
}

async function expectCorrect() {
  expect([...await db.execute<{ ok: boolean }>(sql`select bool_and(description_md5 = md5(coalesce(description, ''))
    and description_has_text = (description is not null and btrim(description) <> '')
    and salary_md5 = md5(coalesce(salary_json::text, ''))) as ok from jobs`)]).toEqual([{ ok: true }]);
  expect([...await db.execute<{ ok: boolean }>(sql`select bool_and(payload_fingerprint = coalesce(payload_hash, md5(payload_json::text))) as ok from raw_postings`)]).toEqual([{ ok: true }]);
}

it("keeps source fingerprints correct for inserts and old-code source updates", async () => {
  await fixture();
  await expectCorrect();
  for (const description of ["Changed 中文", "   ", "", null]) {
    // A rollback binary only knows the source columns, not the new storage columns.
    await db.execute(sql`update jobs set description = ${description}, salary_json = '{"currency":"EUR","min":42}'`);
    await db.execute(sql`update raw_postings set payload_json = '{"changed":true}', payload_hash = null`);
    await expectCorrect();
  }
  await db.execute(sql`update raw_postings set payload_hash = 'new-canonical'`);
  await expectCorrect();
});

it("fills a bounded batch, skips locked rows, and commits progress before the next batch", async () => {
  const jobs = await fixture();
  await db.update(schema.jobs).set({ descriptionMd5: null, descriptionHasText: null, salaryMd5: null });
  await db.update(schema.rawPostings).set({ payloadFingerprint: null });
  await other.begin(async (tx) => {
    await tx`select id from jobs where id = ${jobs[0]!.id} for update`;
    expect(await backfillChangeFingerprints(db, 1)).toEqual({ jobs: 1, rawPostings: 1 });
    expect(await db.select({ hash: schema.jobs.descriptionMd5 }).from(schema.jobs).where(eq(schema.jobs.id, jobs[0]!.id))).toEqual([{ hash: null }]);
    // A separate connection sees the completed batch, without releasing its own lock.
    expect((await tx`select count(*)::int as n from jobs where description_md5 is not null`)[0]?.n).toBe(1);
  });
  expect(await backfillChangeFingerprints(db, 1)).toEqual({ jobs: 1, rawPostings: 1 });
  expect(await backfillChangeFingerprints(db, 1)).toEqual({ jobs: 1, rawPostings: 1 });
  expect(await backfillChangeFingerprints(db, 1)).toEqual({ jobs: 0, rawPostings: 0 });
  await expectCorrect();
});
