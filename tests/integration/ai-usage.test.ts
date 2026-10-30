import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { createAiRouter } from "@/lib/ai/router";
import { createProvider } from "@/lib/ai/provider";
import { createDbUsageStore } from "@/lib/ai/usage";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { AiProviderError } from "@/lib/ai/errors";
import { API_PROVIDER_IDS } from "@/lib/ai/usage";
import { countAiUsageCalls, getAiUsageGroups, getLastAiUsageAt, listAiUsageCalls } from "@/lib/db";
import { insertAiUsage, sumAiCostForMonth } from "@/lib/db/repos/ai-usage";

import { pinnedAi, shippedCatalog, bareCatalog } from "../ai/helpers";

const url = inject("testDatabaseUrl");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

afterAll(async () => {
  await closeDb();
});

describe("ai_usage repo", () => {
  it("sums only the given providers in the given month of the given time zone", async () => {
    const db = getDb();
    await db.execute(sql`truncate table ai_usage`);
    const base = { task: "score", tokensIn: 1, tokensOut: 1 };
    await insertAiUsage(db, { ...base, provider: "anthropic", costEstimate: 1.25, at: new Date("2026-10-31T23:30:00Z") }); // November in Berlin
    await insertAiUsage(db, { ...base, provider: "deepseek", costEstimate: 0.5, at: new Date("2026-10-10T10:00:00Z") });
    await insertAiUsage(db, { ...base, provider: "claude-cli", costEstimate: 0, at: new Date("2026-10-10T10:00:00Z") });
    const providers = ["anthropic", "deepseek", "mimo"];
    expect(await sumAiCostForMonth(db, { month: "2026-10", timeZone: "Europe/Berlin", providers })).toBeCloseTo(0.5, 6);
    expect(await sumAiCostForMonth(db, { month: "2026-11", timeZone: "Europe/Berlin", providers })).toBeCloseTo(1.25, 6);
    expect(await sumAiCostForMonth(db, { month: "2026-10", timeZone: "UTC", providers })).toBeCloseTo(1.75, 6);
    expect(await sumAiCostForMonth(db, { month: "2026-10", timeZone: "UTC", providers: [] })).toBe(0);
    expect(await sumAiCostForMonth(db, { month: "2025-01", timeZone: "UTC", providers })).toBe(0);
  });

  it("a reply that names the model by an alias is priced like the model, in ai_usage", async () => {
    const db = getDb();
    await db.execute(sql`truncate table ai_usage`);
    const catalog = shippedCatalog((raw) => {
      (raw.providers as Record<string, { models: Record<string, unknown>[] }>).anthropic!.models[0]!.aliases = ["claude-haiku-4-5-20251001"];
    });
    const provider = createProvider({
      id: "anthropic",
      availability: () => ({ available: true }),
      call: async () => ({ text: '{"ok":true}', model: "claude-haiku-4-5-20251001", usage: { tokensIn: 1_000_000, tokensOut: 100_000 } }),
    });
    const router = createAiRouter({ config: pinnedAi(), providers: [provider], usage: createDbUsageStore(db), now: () => new Date("2026-10-07T10:00:00Z"), timeZone: "Europe/Berlin", catalog });
    await router.run("score", { system: "s", user: "u" }, z.object({ ok: z.boolean() }));
    const rows = await db.select().from(schema.aiUsage);
    expect(rows[0]?.costEstimate).toBeCloseTo(1.5, 6); // $1 in + 0.1 x $5 out
  });

  it("the router writes ai_usage rows and enforces the budget from them", async () => {
    const db = getDb();
    await db.execute(sql`truncate table ai_usage`);
    const config = pinnedAi((raw) => {
      raw.monthly_api_budget_usd = 1;
    });
    const provider = createProvider({
      id: "anthropic",
      availability: () => ({ available: true }),
      call: async () => ({ text: '{"ok":true}', model: "claude-haiku-4-5", usage: { tokensIn: 1_000_000, tokensOut: 0 } }),
    });
    const now = new Date("2026-10-07T10:00:00Z");
    const router = createAiRouter({ config, providers: [provider], usage: createDbUsageStore(db), now: () => now, timeZone: "Europe/Berlin" });
    const schemaOk = z.object({ ok: z.boolean() });
    const first = await router.run("score", { system: "s", user: "u" }, schemaOk);
    expect(first.usage.costUsd).toBe(1);
    const rows = await db.select().from(schema.aiUsage);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: "anthropic", task: "score", tokensIn: 1_000_000, tokensOut: 0, costEstimate: 1 });
    await expect(router.run("score", { system: "s", user: "u" }, schemaOk)).rejects.toMatchObject({ name: "AiUnavailableError" });
    expect(await db.select().from(schema.aiUsage)).toHaveLength(1);
  });
});

describe("detail columns", () => {
  const base = { task: "score", costEstimate: 0 };
  const reset = async () => {
    await getDb().execute(sql`truncate table ai_usage`);
  };

  it("stores every column, and unknown tokens as NULL", async () => {
    const db = getDb();
    await reset();
    await insertAiUsage(db, { ...base, provider: "codex-cli", model: "gpt-6.1-sol", modelSource: "cli_default", tokensIn: 3000, tokensInCached: 1000, tokensInCacheWrite: 0, tokensOut: 200, tokensOutReasoning: 50, durationMs: 8000, outcome: "ok", equivalentCostUsd: 0.0061 });
    await insertAiUsage(db, { ...base, provider: "codex-cli", tokensIn: null, tokensOut: null, outcome: "failed", errorKind: "timeout", durationMs: 90000 });
    const rows = await db.select().from(schema.aiUsage).orderBy(schema.aiUsage.id);
    expect(rows[0]).toMatchObject({ model: "gpt-6.1-sol", modelSource: "cli_default", tokensInCached: 1000, tokensInCacheWrite: 0, tokensOutReasoning: 50, durationMs: 8000, outcome: "ok", errorKind: null, equivalentCostUsd: 0.0061, jobId: null });
    expect(rows[1]).toMatchObject({ tokensIn: null, tokensOut: null, outcome: "failed", errorKind: "timeout", equivalentCostUsd: null });
  });

  it("the router writes one full row per call; a timeout before the answer writes a failed row too", async () => {
    const db = getDb();
    await reset();
    const timeout = createProvider({ id: "codex-cli", availability: () => ({ available: true }), call: async () => { throw new AiProviderError("codex-cli", "timeout", "timed out"); }, plannedModel: () => "codex-default" });
    const ok = createProvider({
      id: "claude-cli",
      availability: () => ({ available: true }),
      call: async () => ({ text: '{"ok":true}', model: "claude-haiku-4-5", usage: { tokensIn: 10, tokensOut: 5, cachedIn: 2, cacheWriteIn: 0, reasoningOut: 1 } }),
    });
    const catalog = bareCatalog((raw) => {
      (raw.providers as Record<string, { models: Record<string, unknown>[] }>)["claude-cli"]!.models[0]!.equivalent_price = { input_per_mtok: 1, output_per_mtok: 5, source: "test" };
    });
    const router = createAiRouter({ config: pinnedAi(), providers: [timeout, ok], usage: createDbUsageStore(db), now: () => new Date("2026-10-07T10:00:00Z"), timeZone: "Europe/Berlin", catalog });
    await router.run("score", { system: "s", user: "u" }, z.object({ ok: z.boolean() }));
    const rows = await db.select().from(schema.aiUsage).orderBy(schema.aiUsage.id);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ provider: "codex-cli", outcome: "failed", errorKind: "timeout", tokensIn: null, model: "gpt-6.1-sol", modelSource: "cli_default" });
    expect(rows[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(rows[1]).toMatchObject({ provider: "claude-cli", outcome: "ok", model: "claude-haiku-4-5", modelSource: "call", tokensIn: 10, tokensInCached: 2, tokensOutReasoning: 1, costEstimate: 0 });
    expect(rows[1]?.equivalentCostUsd).toBeCloseTo(0.000035, 6);
  });

  it("'last success' ignores failed rows but keeps legacy rows", async () => {
    const db = getDb();
    await reset();
    await insertAiUsage(db, { ...base, provider: "codex-cli", tokensIn: 1, tokensOut: 1, at: new Date("2026-10-01T10:00:00Z") });
    await insertAiUsage(db, { ...base, provider: "codex-cli", tokensIn: null, tokensOut: null, outcome: "failed", at: new Date("2026-10-05T10:00:00Z") });
    await insertAiUsage(db, { ...base, provider: "deepseek", tokensIn: null, tokensOut: null, outcome: "failed", at: new Date("2026-10-05T10:00:00Z") });
    const last = await getLastAiUsageAt(db);
    expect(last.get("codex-cli")?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(last.has("deepseek")).toBe(false);
  });

  it("groups by day in the schedule's time zone, within sargable window edges, with filters", async () => {
    const db = getDb();
    await reset();
    // 23:30 UTC on Oct 6 is already Oct 7 in Berlin (UTC+2)
    await insertAiUsage(db, { ...base, provider: "codex-cli", model: "gpt-6.1-sol", tokensIn: 100, tokensOut: 10, outcome: "ok", equivalentCostUsd: 0.5, at: new Date("2026-10-06T23:30:00Z") });
    await insertAiUsage(db, { ...base, provider: "claude-cli", model: "m", task: "translate", tokensIn: 50, tokensOut: 5, outcome: "ok", at: new Date("2026-10-07T10:00:00Z") });
    await insertAiUsage(db, { ...base, provider: "deepseek", task: "translate", tokensIn: null, tokensOut: null, outcome: "ok", at: new Date("2026-10-07T11:00:00Z") });
    await insertAiUsage(db, { ...base, provider: "codex-cli", tokensIn: 1, tokensOut: 1, at: new Date("2026-10-08T22:00:00Z") }); // Oct 9 in Berlin: outside
    const filter = { from: "2026-10-07", to: "2026-10-08", timeZone: "Europe/Berlin" };
    const groups = await getAiUsageGroups(db, filter, API_PROVIDER_IDS);
    expect(groups.map((g) => [g.day, g.provider, g.calls]).sort()).toEqual([["2026-10-07", "claude-cli", 1], ["2026-10-07", "codex-cli", 1], ["2026-10-07", "deepseek", 1]]);
    const codex = groups.find((g) => g.provider === "codex-cli");
    expect(codex).toMatchObject({ tokenCalls: 1, tokensIn: 100, equivalentUsd: 0.5, equivalentCalls: 1, actualCalls: 1 });
    // an API call without token counts has no known actual spend
    expect(groups.find((g) => g.provider === "deepseek")).toMatchObject({ tokenCalls: 0, actualCalls: 0 });
    expect(await countAiUsageCalls(db, filter)).toBe(3);
    expect(await countAiUsageCalls(db, { ...filter, task: "translate" })).toBe(2);
    expect(await countAiUsageCalls(db, { ...filter, provider: "claude-cli" })).toBe(1);
    expect(await countAiUsageCalls(db, { ...filter, model: "gpt-6.1-sol" })).toBe(1);
    expect(await countAiUsageCalls(db, { ...filter, from: "2026-10-09", to: "2026-10-09" })).toBe(1);
  });

  it("lists newest first with pages and a job join that survives a deleted job as null", async () => {
    const db = getDb();
    await reset();
    await db.execute(sql`truncate table jobs, companies restart identity cascade`);
    const [company] = await db.insert(schema.companies).values({ name: "Acme", nameNorm: "acme" }).returning({ id: schema.companies.id });
    const [job] = await db
      .insert(schema.jobs)
      .values({ companyId: company!.id, title: "Engineer", titleNorm: "engineer", locationsJson: [], workplace: "remote", contract: "permanent", description: "d", status: "active" } as never)
      .returning({ id: schema.jobs.id });
    for (let i = 0; i < 5; i += 1) {
      await insertAiUsage(db, { ...base, provider: "claude-cli", tokensIn: i, tokensOut: 1, outcome: "ok", jobId: i === 4 ? job!.id : null, at: new Date(`2026-10-07T1${i}:00:00Z`) });
    }
    const filter = { from: "2026-10-07", to: "2026-10-07", timeZone: "UTC" };
    const first = await listAiUsageCalls(db, filter, { limit: 2, offset: 0 });
    expect(first.map((r) => r.tokensIn)).toEqual([4, 3]);
    expect(first[0]?.job).toEqual({ id: job!.id, title: "Engineer", company: "Acme" });
    expect((await listAiUsageCalls(db, filter, { limit: 2, offset: 4 })).map((r) => r.tokensIn)).toEqual([0]);
    await db.delete(schema.jobs).where(sql`id = ${job!.id}`);
    expect((await listAiUsageCalls(db, filter, { limit: 1, offset: 0 }))[0]?.job).toBeNull();
    await db.execute(sql`truncate table jobs, companies restart identity cascade`);
  });
});
