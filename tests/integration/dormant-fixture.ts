import { eq, sql } from "drizzle-orm";

import { getDb, schema } from "@/lib/db";
import type { Executor } from "@/lib/db/executor";

export const NOW = new Date("2026-10-28T12:00:00Z");
export const DAY = 86_400_000;
export const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
export const dormancy = { now: NOW, possiblyClosedAfterDays: 7, dormantAfterDays: 30 };
let sequence = 0;

export async function addJob(over: Partial<typeof schema.jobs.$inferInsert> = {}) {
  sequence += 1;
  const [company] = await getDb().insert(schema.companies).values({ name: `Company ${sequence}`, nameNorm: `company ${sequence}` }).returning();
  const [job] = await getDb().insert(schema.jobs).values({
    companyId: company!.id, title: `Engineer ${sequence}`, titleNorm: `engineer ${sequence}`,
    description: "Build reliable systems with Python.", status: "possibly_closed", firstSeenAt: ago(65), lastSeenAt: ago(60), ...over,
  }).returning();
  return job!;
}

export async function marker(id: number, db: Executor = getDb()) {
  const [row] = await db.select({ dormantAt: schema.jobs.dormantAt }).from(schema.jobs).where(eq(schema.jobs.id, id));
  return row!.dormantAt;
}

export async function addSource(id: number, fetchedAt = ago(60)) {
  const db = getDb();
  await db.execute(sql`insert into channels (id, family, kind) values ('fx', 'manual', 'manual') on conflict do nothing`);
  const [raw] = await db.insert(schema.rawPostings).values({ channelId: "fx", externalId: String(id), payloadJson: {}, fetchedAt }).returning();
  await db.insert(schema.jobSources).values({ jobId: id, rawPostingId: raw!.id, channelId: "fx", url: `https://jobs.example/${id}` });
  return raw!;
}
