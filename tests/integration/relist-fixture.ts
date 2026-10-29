import { sql } from "drizzle-orm";

import { registerFixtureChannel, type FixturePosting } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { getDb, schema } from "@/lib/db";
import { pipelineWith } from "../pipeline/helpers";
import { quietLogger } from "../cycle/helpers";
import { ago, NOW } from "./dormant-fixture";

export const relist = { minGapDays: 9 };
export const posting: FixturePosting = {
  id: "listing", company: "Example Labs", title: "Engineer", city: null, country: null,
  description: "Build reliable systems with Python.", remote: false, posted_at: null, url: "https://jobs.example.test/listing",
};

export function pipelineOptions() {
  const registry = new ChannelRegistry();
  registerFixtureChannel(registry, { id: "fx", family: "manual", postings: [posting] });
  return { relist, registry, logger: quietLogger, config: pipelineWith((raw) => {
    const lifecycle = raw.lifecycle as Record<string, unknown>;
    lifecycle.max_link_checks_per_cycle = 0;
    lifecycle.unseen_link_check_after_days = 0;
    lifecycle.dormant_after_days = 0;
  }) };
}

export async function addRun(input: { at?: Date; cycleId?: number | null; channelId?: string; status?: "succeeded" | "failed" | "partial"; extended?: boolean; finishedAt?: Date | null } = {}) {
  const db = getDb();
  const channelId = input.channelId ?? "fx";
  await db.execute(sql`insert into channels (id, family, kind) values (${channelId}, 'manual', 'manual') on conflict do nothing`);
  const at = input.at ?? ago(10);
  let cycleId = input.cycleId;
  if (cycleId === undefined) {
    const [cycle] = await db.insert(schema.cycles).values({ kind: "manual", status: "succeeded", startedAt: at, finishedAt: new Date(at.getTime() + 1000) }).returning();
    cycleId = cycle!.id;
  }
  const [run] = await db.insert(schema.runs).values({ channelId, cycleId, startedAt: at,
    finishedAt: input.finishedAt === undefined ? new Date(at.getTime() + 1000) : input.finishedAt,
    status: input.status ?? "succeeded", windowExtended: input.extended ?? false }).returning();
  return run!;
}

export const maintenanceOptions = () => ({ ...pipelineOptions(), now: () => NOW, http: {
  request: async (): Promise<never> => { throw new Error("unexpected request"); },
  json: async (): Promise<never> => { throw new Error("unexpected request"); },
} });
