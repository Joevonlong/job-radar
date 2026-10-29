import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { registerCycleStep, resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, schema, upsertRawPostings } from "@/lib/db";
import { getJob } from "@/lib/db/repos/jobs";
import { resetListingCache } from "@/lib/db/repos/listing";
import { runMaintenance, runPipeline } from "@/lib/pipeline";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { addJob, ago } from "./dormant-fixture";
import { addRun, maintenanceOptions, pipelineOptions, posting } from "./relist-fixture";

let temp: TempConfig;
beforeAll(() => { process.env.DATABASE_URL = inject("testDatabaseUrl"); });
beforeEach(() => { temp = makeTempConfig(); resetCycleSteps(); resetListingCache(); });
afterEach(() => { temp.cleanup(); resetCycleSteps(); resetListingCache(); });
afterAll(closeDb);

it.each([
  { name: "one down channel, identical posting returned by both recovery queries", channels: 1, changed: false, absence: false },
  { name: "second recovery query overwrites fetched_at and run_id with changed content", channels: 1, changed: true, absence: false },
  { name: "two down source channels return in the same recovery cycle", channels: 2, changed: false, absence: false },
  { name: "an earlier cycle succeeded without the job", channels: 1, changed: false, absence: true },
])("collect → pipeline → maintenance: $name", async ({ channels, changed, absence }) => {
  const db = getDb();
  const job = await addJob({ status: "active", lastSeenAt: ago(20), lastListedAt: ago(20) });
  const registry = new ChannelRegistry();
  const calls = new Map<string, number>();
  for (let index = 0; index < channels; index += 1) {
    const id = index === 0 ? "fx" : "fx-other";
    const channel = registerFixtureChannel(registry, { id, family: "manual", usesQueries: true, postings: [posting] });
    const collect = channel.collect.bind(channel);
    channel.collect = async (query, ctx) => {
      const n = (calls.get(id) ?? 0) + 1;
      calls.set(id, n);
      const items = await collect(query, ctx);
      return changed && n === 2 ? items.map((item) => ({ ...item, payload: { ...posting, description: posting.description + " New information." } })) : items;
    };
    await addRun({ channelId: id, status: "failed", at: ago(19) });
    await upsertRawPostings(db, { channelId: id, runId: null, fetchedAt: ago(20), items: [{ externalId: posting.id, url: posting.url, payload: posting }] });
    const [raw] = await db.select().from(schema.rawPostings).where(eq(schema.rawPostings.channelId, id));
    await db.update(schema.rawPostings).set({ parseStatus: "parsed" }).where(eq(schema.rawPostings.id, raw!.id));
    await db.insert(schema.jobSources).values({ jobId: job.id, channelId: id, rawPostingId: raw!.id, url: posting.url });
  }
  if (absence) await addRun();
  const pipeline = { ...pipelineOptions(), registry };
  registerCycleStep("pipeline", async (ctx) => ({ result: await runPipeline(db, { ...pipeline, signal: ctx.signal }) }));
  registerCycleStep("maintenance", async () => ({ result: await runMaintenance(db, { ...maintenanceOptions(), now: () => new Date() }) }));
  registerCycleStep("ai", async () => {});
  const configs = config();
  configs.search = { ...configs.search, keyword_groups: { one: ["Engineer"], two: ["Developer"] }, locations: ["Testville"], remote_scope: "none" };
  configs.channels = { ...configs.channels, collect: { ...configs.channels.collect, concurrency: 1 } };
  const result = await runCycle("manual", { registry, config: configs, cascades: [], logger: quietLogger, sleep: async () => {}, db });
  expect(result.status).toBe("succeeded");
  expect([...calls.values()]).toEqual(Array(channels).fill(2));
  const recoveryRuns = await db.select().from(schema.runs).where(eq(schema.runs.cycleId, result.cycleId!)).orderBy(schema.runs.id);
  expect(recoveryRuns).toHaveLength(channels * 2);
  for (const raw of await db.select().from(schema.rawPostings)) {
    const sourceRuns = recoveryRuns.filter((run) => run.channelId === raw.channelId);
    expect(raw.runId).toBe(sourceRuns.at(-1)?.id);
    expect(sourceRuns[0]!.finishedAt!.getTime()).toBeLessThan(raw.fetchedAt.getTime());
  }
  const stored = await getJob(db, job.id);
  expect(stored?.relistCount ?? 0).toBe(absence ? 1 : 0);
  expect(stored?.relistedAt !== null).toBe(absence);
  expect(stored?.lastListedAt?.getTime()).toBeGreaterThan(ago(1).getTime());
  expect(result.results.pipeline).toMatchObject({ relisted: changed && absence ? 1 : 0 });
  expect(result.results.maintenance).toMatchObject({ relisted: !changed && absence ? 1 : 0 });
});
