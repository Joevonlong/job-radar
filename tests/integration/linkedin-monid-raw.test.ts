import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { createMonidChannel, unidentifiedExternalId } from "@/lib/channels/linkedin/monid";
import { ChannelRegistry } from "@/lib/channels/registry";
import { runCycle } from "@/lib/cycle/run-cycle";
import { closeDb, getDb, getMonthUsage, listRawPostingsForChannel, listRunsForCycle } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { runPipeline } from "@/lib/pipeline";

import { shippedSearch } from "../channels/helpers";
import { config, quietLogger } from "../cycle/helpers";
import { shippedPipeline } from "../pipeline/helpers";
import { ENV, MONID, MONTH, NOW, monidChannels, monidJob, monidProvider } from "./linkedin-monid-helpers";

beforeAll(async () => {
  process.env.DATABASE_URL = inject("testDatabaseUrl");
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});
afterAll(async () => { await closeDb(); });

describe("Monid raw posting retention and accounting", () => {
  it("stores normal, invalid and unidentified items before parsing and keeps their billed cost", async () => {
    const normal = monidJob("4386000101");
    const invalid = { ...monidJob("4386000102"), title: null };
    const unidentified = { ...monidJob("4386000103"), id: null, linkedinUrl: null };
    const output = [normal, invalid, unidentified];
    const provider = monidProvider(output);
    const registry = new ChannelRegistry();
    registry.register(createMonidChannel({ pricePer1kUsd: () => 1, environment: ENV, now: () => NOW, sleep: async () => {} }));
    const search = { ...shippedSearch(), keyword_groups: { engineering: ["Platform Engineer"] }, locations: ["Example City"],
      remote_scope: "none" as const, max_per_group_per_location: 10 };
    const result = await runCycle("manual", { registry, channelIds: [MONID], cascades: [{ family: "linkedin", order: [MONID] }],
      config: { ...config({ search }), channels: monidChannels() }, logger: quietLogger, fetch: provider.fetch, sleep: async () => {}, now: () => NOW });
    expect(result.status).toBe("succeeded");
    const before = await listRawPostingsForChannel(getDb(), MONID);
    expect(before).toHaveLength(3);
    expect(before.map((row) => row.payloadJson)).toEqual(output);
    expect(before.every((row) => row.parseStatus === "pending")).toBe(true);
    expect(before[2]?.externalId).toBe(unidentifiedExternalId(unidentified));
    expect(before[2]?.externalId).toMatch(/^unidentified:[a-f0-9]{64}$/);

    const pipeline = await runPipeline(getDb(), { relist: { minGapDays: 9 }, registry, config: shippedPipeline(), logger: quietLogger });
    expect(pipeline).toMatchObject({ processed: 3, parsed: 1, created: 1, parseFailed: 2, deferred: 0 });
    const after = await listRawPostingsForChannel(getDb(), MONID);
    expect(after.map((row) => [row.externalId, row.parseStatus])).toEqual([
      ["4386000101", "parsed"], ["4386000102", "parse_failed"], [unidentifiedExternalId(unidentified), "parse_failed"],
    ]);
    expect(after.map((row) => row.payloadJson)).toEqual(output);
    expect(after[2]?.parseError).toContain("no LinkedIn job id");
    const usage = (await getMonthUsage(getDb(), MONTH)).get(MONID);
    expect(usage?.records).toBe(3);
    expect(usage?.usd).toBeCloseTo(0.004, 6);
    const [run] = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(run).toMatchObject({ channelId: MONID, fetched: 3, usageUnits: 3, status: "succeeded" });
    expect(Number(run?.cost)).toBeCloseTo(0.004, 6);
  });
});
