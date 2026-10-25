import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { AiProviderError } from "@/lib/ai/errors";
import { createDbHealthStore, healthDay, listProviderHealth } from "@/lib/ai/health";
import { aiProviderState } from "@/lib/ai/provider-state";
import { salarySchema, type AiConfig, type SalaryConfig } from "@/lib/config";
import { createSalaryLookupHandler } from "@/lib/control/salary-lookup";
import { createTranslateJobHandler } from "@/lib/control/translate-job";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { insertAiUsage } from "@/lib/db/repos/ai-usage";
import { insertControlRequest } from "@/lib/db/repos/control-requests";
import { createRequestRouter } from "@/lib/translation/router";

import { pinnedAi, scriptedProvider } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-08T10:00:00Z");
const TZ = "UTC";
const db = () => getDb();
const context = () => ({ db: db(), signal: new AbortController().signal, logger: quietLogger });

const salaryAnswer = JSON.stringify({
  company_level: { level: "above", annual_median: 100000, currency: "EUR", summary: "Pays above the market.", source_indexes: [0] },
  role_band: { title: "ML Engineer", seniority: "Senior", annual_min: 95000, annual_max: 115000, annual_median: 105000, currency: "EUR", basis: "base", location: "Berlin, Germany", source_indexes: [0] },
  related_roles: [],
  sources: [{ url: "https://www.levels.fyi/companies/acme/salaries", site: "Levels.fyi", title: "Acme", excerpt: "105k" }],
  confidence: "medium",
  notes: "",
});
const translated = JSON.stringify({ translation: "## 职位\n\n加入我们的团队，为临床数据构建检索系统。我们重视严谨的工程实践。" });

/** Built here: the test never depends on the shipped salary.yaml. */
const salary = (): SalaryConfig =>
  salarySchema.parse({
    benchmark: { enabled: true, window_days: 365, min_sample: 3 },
    role_families: [{ id: "ml_engineer", label: { en: "ML engineer" }, patterns: ["\\b(?:ml|machine learning|ai)\\s+engineer\\b"] }],
    deep_links: [],
    lookup: { enabled: true, ttl_days: 30, max_per_day: 3, timeout_seconds: 60, max_searches: 4, allowed_fetch_domains: ["levels.fyi"], sanity_annual: { min: 5000, max: 2000000 }, unconvertible_max_annual: 100_000_000_000, web_search_usd: 0.01 },
  });

/** codex-cli first with a daily cap of 1, claude-cli second, for every on-demand task. */
function capped(): AiConfig {
  return pinnedAi((raw) => {
    const providers = raw.providers as Record<string, Record<string, unknown>>;
    providers.codex_cli!.daily_request_cap = 1;
    providers.claude_cli!.daily_request_cap = 0;
    const tasks = raw.tasks as Record<string, unknown>;
    tasks.translate = { order: ["codex-cli", "claude-cli"] };
    tasks.salary_lookup = { order: ["codex-cli", "claude-cli"] };
  });
}

async function addJob(title: string): Promise<number> {
  const [company] = await db().insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title.toLowerCase()}` }).returning();
  const [job] = await db()
    .insert(schema.jobs)
    .values({
      companyId: company!.id,
      title,
      titleNorm: title.toLowerCase(),
      seniority: "senior",
      description: `## Role\n\nJoin our team and build retrieval systems for clinical data. ${"We value careful engineering. ".repeat(6)}`,
      language: "en",
      locationsJson: [{ label: "Berlin, DE", city: "Berlin", countryCode: "DE", isPrimary: true }],
    })
    .returning();
  return job!.id;
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(async () => {
  await db().execute(sql`delete from runtime_state where key like 'ai_provider:%'`);
  await db().execute(sql`truncate table jobs, companies, ai_usage, salary_lookups, cycles restart identity cascade`);
});
afterAll(async () => {
  await closeDb();
});

describe("on-demand AI requests share the provider health of the runner and the ai-worker", () => {
  it("a translate request ignores a full per-cycle cap, and stops at a full window with quota_guard and the resume time", async () => {
    await db().execute(sql`delete from runtime_state where key like 'ai_quota:%'`);
    const config = pinnedAi((raw) => {
      (raw.tasks as Record<string, unknown>).translate = { order: ["codex-cli"] };
      raw.quota_guard = { providers: { codex_cli: { window_hours: 5, hard_requests: 5, cycle_request_cap: 2 }, claude_cli: { hard_requests: 0, cycle_request_cap: 0 } } };
    });
    // a cycle started 30 minutes ago and already made 3 codex calls: over its per-cycle cap of 2
    await db().insert(schema.cycles).values({ kind: "weekday_morning", startedAt: new Date(NOW.getTime() - 30 * 60_000) });
    const used = (count: number) => Promise.all(Array.from({ length: count }, (_, i) => insertAiUsage(db(), { provider: "codex-cli", task: "score", tokensIn: 1, tokensOut: 1, costEstimate: 0, at: new Date(NOW.getTime() - (i + 1) * 60_000) })));
    await used(3);
    const codex = scriptedProvider("codex-cli", [translated, translated]);
    const handler = createTranslateJobHandler({ createRouter: (ctx) => createRequestRouter(ctx.db, ctx.logger, { config, providers: [codex.provider], timeZone: TZ, now: () => NOW }) });
    const jobId = await addJob("ML Engineer");
    expect(await handler(await insertControlRequest(db(), { kind: "translate_job", payload: { jobId, force: false } }), context())).toMatchObject({ status: "done", result: { provider: "codex-cli" } });

    // 3 + the translation + 1 more = 5 calls in the window: the window cap holds every request back
    await used(1);
    const outcome = await handler(await insertControlRequest(db(), { kind: "translate_job", payload: { jobId, force: true } }), context());
    expect(outcome).toMatchObject({ status: "failed", result: { error: "quota_guard", resumeAt: expect.any(String) } });
    expect(codex.transport.calls).toHaveLength(1);
  });

  it("a translate request skips a provider at its daily cap and counts the call against the one it used", async () => {
    // the runner already used codex's one request today
    await createDbHealthStore(db()).noteRequest("codex-cli", NOW, healthDay(NOW, TZ));
    const codex = scriptedProvider("codex-cli", [translated]);
    const claude = scriptedProvider("claude-cli", [translated]);
    const jobId = await addJob("ML Engineer");
    const handler = createTranslateJobHandler({ createRouter: (ctx) => createRequestRouter(ctx.db, ctx.logger, { config: capped(), providers: [codex.provider, claude.provider], timeZone: TZ, now: () => NOW }) });
    const request = await insertControlRequest(db(), { kind: "translate_job", payload: { jobId, force: false } });
    const outcome = await handler(request, context());
    expect(outcome).toMatchObject({ status: "done", result: { provider: "claude-cli" } });
    expect(codex.transport.calls).toHaveLength(0);
    const health = await listProviderHealth(db());
    expect(health.get("codex-cli")?.requestsToday).toBe(1);
    expect(health.get("claude-cli")).toMatchObject({ requestsToday: 1 });
    expect(health.get("claude-cli")?.lastSuccessAt).not.toBeNull();
  });

  it("a salary lookup skips the capped provider, and a login failure is stored so Settings can show it", async () => {
    await createDbHealthStore(db()).noteRequest("codex-cli", NOW, healthDay(NOW, TZ));
    const codex = scriptedProvider("codex-cli", [salaryAnswer]);
    const claude = scriptedProvider("claude-cli", [new AiProviderError("claude-cli", "auth", "OAuth session expired")]);
    const jobId = await addJob("ML Engineer");
    const handler = createSalaryLookupHandler({
      createRouter: (ctx) => createRequestRouter(ctx.db, ctx.logger, { config: capped(), providers: [codex.provider, claude.provider], timeZone: TZ, now: () => NOW }),
      loadSettings: salary,
      loadMoney: () => ({ currency: "EUR", fx: { fx_pivot: "EUR", fx_rates: {} } }),
    });
    const request = await insertControlRequest(db(), { kind: "salary_lookup", payload: { jobId, force: false } });
    const outcome = await handler(request, context());
    expect(outcome.status).toBe("failed");
    expect(codex.transport.calls).toHaveLength(0);
    expect(claude.transport.calls).toHaveLength(1);

    const claudeHealth = (await listProviderHealth(db())).get("claude-cli");
    expect(claudeHealth).toMatchObject({ lastErrorKind: "auth", requestsToday: 1 });
    // what Settings → AI and /sources derive from the stored row
    expect(
      aiProviderState({
        configured: true,
        enabled: true,
        coolingUntil: null,
        dailyCap: 0,
        requestsToday: claudeHealth!.requestsToday,
        lastErrorKind: claudeHealth!.lastErrorKind,
        lastErrorAt: claudeHealth!.lastErrorAt,
        lastSuccessAt: claudeHealth!.lastSuccessAt,
      }),
    ).toBe("auth");
  });
});
