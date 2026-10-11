import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { AiProviderError } from "@/lib/ai/errors";
import { createDbHealthStore, listProviderHealth } from "@/lib/ai/health";
import { createAiRouter } from "@/lib/ai/router";
import { closeDb, getDb } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";

import { scriptedProvider, pinnedAi } from "../ai/helpers";
import { buildSourcesView } from "@/lib/sources/view";
import { loadConfig } from "@/lib/config";

const url = inject("testDatabaseUrl");
const schema = z.object({ ok: z.boolean() });
const prompt = { system: "s", user: "u" };
const NOW = new Date("2026-10-07T10:00:00Z");

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

afterAll(async () => {
  await closeDb();
});

describe("provider health in the database", () => {
  it("one process's session-limit error makes another process's router skip the provider, and /sources can read it", async () => {
    const db = getDb();
    await db.execute(sql`delete from runtime_state where key like 'ai_provider:%'`);
    const config = pinnedAi((raw) => { raw.order = ["claude-cli", "codex-cli"]; });
    const limited = scriptedProvider("claude-cli", [new AiProviderError("claude-cli", "rate_limited", "You've hit your session limit · resets 5pm")]);
    const codex = scriptedProvider("codex-cli", ['{"ok": true}']);
    const make = (providers: ReturnType<typeof scriptedProvider>["provider"][]) =>
      createAiRouter({ config, providers, usage: null, health: createDbHealthStore(db), now: () => NOW, timeZone: "Europe/Berlin" });

    // process A (the runner / an earlier request) hits the limit
    expect((await make([limited.provider, codex.provider]).run("score", prompt, schema)).provider).toBe("codex-cli");
    // process B starts later with a fresh router: it must not call claude-cli at all
    const fresh = scriptedProvider("claude-cli", ['{"ok": true}']);
    expect((await make([fresh.provider, codex.provider]).run("score", prompt, schema)).provider).toBe("codex-cli");
    expect(fresh.transport.calls).toHaveLength(0);

    const health = await listProviderHealth(db);
    expect(health.get("claude-cli")).toMatchObject({ lastErrorKind: "rate_limited", requestsToday: 1 });
    expect(health.get("claude-cli")?.coolingUntil).not.toBeNull();
    expect(health.get("codex-cli")).toMatchObject({ requestsToday: 2, coolingUntil: null });
    expect(health.get("codex-cli")?.lastSuccessAt).not.toBeNull();

    const view = buildSourcesView({
      now: NOW,
      month: "2026-10",
      channelsConfig: loadConfig("channels"),
      aiConfig: config,
      aiHealth: health,
      timeZone: "Europe/Berlin",
      states: [],
      runsByChannel: new Map(),
      usage: new Map(),
      runTotals: new Map(),
      latestCycle: null,
      aiRows: [],
      apiSpendUsd: 0,
      lastHeartbeatAt: null,
      heartbeatIntervalSeconds: 30,
      heartbeatStaleFactor: 3,
      aiWorker: { configured: true } as never,
    });
    const claude = view.ai.providers.find((p) => p.id === "claude-cli");
    expect(claude?.coolingUntil).not.toBeNull();
    expect(claude?.dailyCap).toBe(50);
    expect(view.ai.providers.find((p) => p.id === "codex-cli")).toMatchObject({ requestsToday: 2, dailyCap: 0, coolingUntil: null });
  });
});
