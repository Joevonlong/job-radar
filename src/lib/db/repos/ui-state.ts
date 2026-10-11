import { z } from "zod";

import type { Db } from "../client";
import { afterVisit, type VisitState } from "@/lib/jobs/visit";
import { getRuntimeState, setRuntimeState } from "./runtime-state";

/**
 * Where the dashboard keeps "when did I last look". It lives in `runtime_state` (the small
 * key/value table that already exists, key `ui:visit`) rather than in a cookie or a table of its own:
 * the marker is then the same on the desktop and on the phone (a Telegram link opens the phone), a server component can read it while rendering (cookies
 * can only be written from actions), and it needs no migration.
 */
const VISIT_KEY = "ui:visit";

const storedSchema = z.object({
  seenUpTo: z.iso.datetime({ offset: true }).nullable(),
  lastActiveAt: z.iso.datetime({ offset: true }),
});

export async function getVisitState(db: Db): Promise<VisitState | null> {
  const row = await getRuntimeState(db, VISIT_KEY);
  const parsed = storedSchema.safeParse(row?.value);
  if (!parsed.success) return null;
  return { seenUpTo: parsed.data.seenUpTo === null ? null : new Date(parsed.data.seenUpTo), lastActiveAt: new Date(parsed.data.lastActiveAt) };
}

async function saveVisitState(db: Db, state: VisitState): Promise<void> {
  await setRuntimeState(db, VISIT_KEY, { seenUpTo: state.seenUpTo?.toISOString() ?? null, lastActiveAt: state.lastActiveAt.toISOString() });
}

/** The user opened Today or /jobs. */
export async function recordVisit(db: Db, now: Date): Promise<VisitState> {
  const next = afterVisit(await getVisitState(db), now);
  await saveVisitState(db, next);
  return next;
}
