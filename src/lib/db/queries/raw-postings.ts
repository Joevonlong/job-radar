import { desc, eq } from "drizzle-orm";

import type { Db } from "../client";
import { channels, jobs, jobSources, rawPostings } from "../schema";

/** Null distinguishes an unknown job from an existing job with no source payloads. */
export async function getRawPostingsForJob(db: Db, jobId: number) {
  const [job] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!job) return null;
  return db.select({
    channelId: channels.id,
    url: jobSources.url,
    fetchedAt: rawPostings.fetchedAt,
    parseStatus: rawPostings.parseStatus,
    parseError: rawPostings.parseError,
    payloadJson: rawPostings.payloadJson,
  }).from(jobSources)
    .innerJoin(rawPostings, eq(jobSources.rawPostingId, rawPostings.id))
    .innerJoin(channels, eq(rawPostings.channelId, channels.id))
    .where(eq(jobSources.jobId, jobId))
    .orderBy(desc(rawPostings.fetchedAt), desc(rawPostings.id));
}

export type RawPostingForJob = NonNullable<Awaited<ReturnType<typeof getRawPostingsForJob>>>[number];
