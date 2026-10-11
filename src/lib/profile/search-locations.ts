/**
 * /me "What I want" keeps the places a job must match (preferences.yaml `locations`); search.yaml `locations` are the
 * cities every keyword group is searched in. They start out equal (the setup wizard writes both) and then drift apart,
 * so /me offers to copy its places into the search cities. Server only.
 */
import { z } from "zod";

import { reloadConfig, searchSchema, writeConfig } from "@/lib/config";
import { cleanTitles } from "@/lib/setup/keywords";

const requestSchema = z.array(z.string().max(120)).min(1).max(50);

export type SyncSearchLocationsResult = { status: "done"; locations: string[] } | { status: "error"; error: "invalid" | "unreadable" | "write_failed" };

/** Replace search.yaml `locations` with `raw` (untrusted). Nothing else in the file changes. */
export async function syncSearchLocations(raw: unknown): Promise<SyncSearchLocationsResult> {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) return { status: "error", error: "invalid" };
  const locations = cleanTitles(parsed.data);
  if (locations.length === 0) return { status: "error", error: "invalid" };
  let current;
  try {
    current = structuredClone(reloadConfig("search"));
  } catch {
    return { status: "error", error: "unreadable" };
  }
  const next = searchSchema.safeParse({ ...current, locations });
  if (!next.success) return { status: "error", error: "invalid" };
  try {
    await writeConfig("search", next.data);
  } catch {
    return { status: "error", error: "write_failed" };
  }
  return { status: "done", locations };
}
