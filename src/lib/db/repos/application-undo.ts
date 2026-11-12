import { desc, eq } from "drizzle-orm";

import type { Executor } from "../executor";
import { applicationEvents, applications } from "../schema";
import { lockApplicationCreation } from "./application-lock";

/** Lock an existing application before reading a field; serialize an absent one with every application creator. */
export async function readApplicationForUndo(db: Executor, jobId: number) {
  const read = async () => (await db.select().from(applications).where(eq(applications.jobId, jobId)).for("update"))[0] ?? null;
  let application = await read();
  if (!application) {
    await lockApplicationCreation(db, jobId);
    application = await read();
  }
  return application;
}

export async function latestApplicationEventId(db: Executor, applicationId: number): Promise<number | null> {
  const [row] = await db.select({ id: applicationEvents.id }).from(applicationEvents)
    .where(eq(applicationEvents.applicationId, applicationId)).orderBy(desc(applicationEvents.id)).limit(1);
  return row?.id ?? null;
}
