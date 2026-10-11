/**
 * Signal presets against Postgres: the /interests hit preview equals running `findCandidates` on the same jobs, reads only, and its
 * review estimate counts exactly what `listJobsToReview` would hand the AI.
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { reloadConfig } from "@/lib/config";
import { closeDb, getDb, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { countJobsToReview, listJobsToReview, listRecentJobsForPreview } from "@/lib/db/repos/signals";
import { previewCategory } from "@/lib/interests/preview";
import { configToDraft, newCategoryDraft } from "@/lib/interests/vocabulary-draft";
import { loadPipeline } from "@/lib/market";
import { findCandidates, runRuleScan, signalsPrompt } from "@/lib/signals";

import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiTransport } from "@/lib/ai/types";
import { listSignalsOfJob } from "@/lib/db/repos/signals";
import { reconcileBonuses, runAiReview } from "@/lib/signals";

import { pinnedAi } from "../ai/helpers";
import { quietLogger } from "../cycle/helpers";
import { rawCategories, shippedInterests } from "../signals/helpers";

const url = inject("testDatabaseUrl");

async function newJob(title: string, description: string, options: { filterResult?: "passed" | "filtered_out"; status?: "active" | "closed" } = {}): Promise<number> {
  const db = getDb();
  const [company] = await db.insert(schema.companies).values({ name: `Co ${title}`, nameNorm: `co ${title}`.toLowerCase() }).returning({ id: schema.companies.id });
  const [job] = await db
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description, status: options.status ?? "active" })
    .returning({ id: schema.jobs.id });
  await db.insert(schema.scores).values({ jobId: job!.id, filterResult: options.filterResult ?? "passed", score: 60, rankValue: 60 });
  return job!.id;
}

const resetTables = () => getDb().execute(sql`truncate table jobs, companies restart identity cascade`);
const tableCounts = async () => {
  const rows = await getDb().execute<{ signals: string; scans: string; requests: string; usage: string }>(
    sql`select (select count(*) from signals) as signals, (select count(*) from signal_scans) as scans, (select count(*) from control_requests) as requests, (select count(*) from ai_usage) as usage`,
  );
  return Array.from(rows)[0];
};

/** The saved vocabulary plus a new keyword category `perk` (as the add dialog makes it). */
function draftWithPerk(fields: { keywords?: string[]; aiDefinition?: string } = {}) {
  const draft = configToDraft(reloadConfig("interests"));
  const perk = newCategoryDraft({ id: "perk", kind: "keyword", labelZh: "", labelEn: "Perk", color: "violet" }, { aiDefinition: fields.aiDefinition ?? "the employer pays for AI tools", keywords: fields.keywords ?? ["unlimited tokens"], weight: "2" });
  return { ...draft, categories: [...draft.categories, perk] };
}

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(resetTables);
afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("previewCategory", () => {
  it("counts and quotes what findCandidates finds on the newest open, unfiltered jobs, and writes nothing", async () => {
    await newJob("A", "Benefits: unlimited tokens for every engineer. Remote work.");
    await newJob("B", "We build payment software.");
    await newJob("C", "Perks. You get unlimited tokens and a laptop.");
    await newJob("D filtered", "unlimited tokens here too", { filterResult: "filtered_out" });
    await newJob("E closed", "unlimited tokens here too", { status: "closed" });
    const before = await tableCounts();

    const result = await previewCategory({ draft: draftWithPerk(), categoryId: "perk" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;

    const interests = reloadConfig("interests");
    const jobs = await listRecentJobsForPreview(getDb(), interests.limits.preview_jobs);
    expect(jobs.map((job) => job.title).sort()).toEqual(["A", "B", "C"]);
    const config = { signals: { ...interests.signals, categories: [{ id: "perk", kind: "keyword" as const, label: { en: "Perk" }, color: "violet" as const, weight: 2, high_value: false, ai_confirm_only: false, ai_definition: "x", keywords: ["unlimited tokens"], patterns: [], exclude: [] }] }, limits: interests.limits };
    const direct = jobs.filter((job) => findCandidates(job.description, config, loadPipeline()).some((candidate) => candidate.tier === "perk"));
    expect(result.scanned).toBe(3);
    expect(result.truncated).toBe(false);
    expect(result.hits).toBe(direct.length);
    expect(result.hits).toBe(2);
    expect(result.samples.map((sample) => sample.title).sort()).toEqual(["A", "C"]);
    expect(result.samples.every((sample) => sample.quote.toLowerCase().includes("unlimited tokens"))).toBe(true);
    expect(await tableCounts()).toEqual(before);
  });

  it("estimates the AI review a save causes: the jobs listJobsToReview would select with the new prompt version", async () => {
    await newJob("A", "Benefits: unlimited tokens for every engineer.");
    await newJob("B", "We build payment software.");
    await newJob("C", "Remote. Visa sponsorship available.", { filterResult: "filtered_out" });
    const interests = reloadConfig("interests");
    await runRuleScan(getDb(), { interests, pipeline: loadPipeline(), logger: quietLogger, batchSize: 50 });

    const result = await previewCategory({ draft: draftWithPerk(), categoryId: "perk" });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.review).not.toBeNull();
    const version = signalsPrompt({ signals: { ...interests.signals, categories: [...interests.signals.categories, { id: "perk", kind: "keyword", label: { en: "Perk" }, color: "violet", weight: 2, high_value: false, ai_confirm_only: false, ai_definition: "the employer pays for AI tools", keywords: ["unlimited tokens"], patterns: [], exclude: [] }] } })!.version;
    for (const withoutCandidates of [true, false]) {
      const listed = await listJobsToReview(getDb(), { promptVersion: version, limit: 10_000, withoutCandidates });
      expect(await countJobsToReview(getDb(), { promptVersion: version, withoutCandidates })).toBe(listed.length);
    }
    expect(result.review?.jobs).toBe(2);
    expect(result.review?.rounds).toBe(Math.ceil(2 / reloadConfig("ai").per_cycle_limit));

    // the saved vocabulary itself changes nothing for the AI
    const unchanged = await previewCategory({ draft: configToDraft(interests), categoryId: interests.signals.categories[0]!.id });
    expect(unchanged.status === "ok" && unchanged.review).toBeNull();
  });

  it("stops at the time budget and says the result is partial", async () => {
    await newJob("A", "Benefits: unlimited tokens for every engineer.");
    await newJob("B", "Perks: unlimited tokens.");
    await newJob("C", "Unlimited tokens again.");
    const budget = reloadConfig("interests").limits.preview_time_budget_ms;
    // the deadline and the check before the first job read 0; every later check reads the deadline
    let calls = 0;
    const now = () => (calls++ < 2 ? 0 : budget);
    const result = await previewCategory({ draft: draftWithPerk(), categoryId: "perk" }, { now });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.truncated).toBe(true);
    expect(result.scanned).toBe(1);
    expect(result.hits).toBe(1);
  });

  it("reports the draft's own errors, and refuses an unknown category or a malformed request", async () => {
    const bad = draftWithPerk({ aiDefinition: "" });
    const result = await previewCategory({ draft: bad, categoryId: "perk" });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") expect(result.fieldErrors[0]?.path.startsWith(`categories.${bad.categories.length - 1}`)).toBe(true);
    expect((await previewCategory({ draft: draftWithPerk(), categoryId: "nope" })).status).toBe("invalidPayload");
    expect((await previewCategory({ draft: {}, categoryId: "perk" })).status).toBe("invalidPayload");
  });
});

describe("a category with only an AI definition (no words)", () => {
  it("the AI finds it: the signal is stored with its verbatim quote and adds the weight; a quote not in the JD is dropped", async () => {
    const good = await newJob("Good", "## Benefits\nEvery engineer gets an uncapped budget for Claude and Cursor seats.\nRemote work.");
    const bad = await newJob("Bad", "## Benefits\nRemote work and a laptop.");
    const interests = shippedInterests((raw) => {
      rawCategories(raw).push({ id: "ai_tools", kind: "keyword", label: { en: "AI tools" }, color: "violet", weight: 4, ai_definition: "the employer pays for AI tools for the employee" });
    });
    expect(interests.limits.ai_review_without_candidates).toBe(true);
    const pipeline = loadPipeline();
    await runRuleScan(getDb(), { interests, pipeline, logger: quietLogger, batchSize: 50 });
    const transport: AiTransport = {
      id: "claude-cli",
      availability: () => ({ available: true }),
      async call(request) {
        expect(request.system).toContain("- ai_tools: the employer pays for AI tools for the employee");
        const quote = request.user.includes("uncapped budget") ? "Every engineer gets an uncapped budget for Claude and Cursor seats." : "Unlimited tokens for everyone.";
        return { text: JSON.stringify({ signals: [{ tier: "ai_tools", kind: "ai_tools", quote, candidate: null, amount: null }], rejected: [] }), model: "fake", usage: { tokensIn: 1, tokensOut: 1 } };
      },
    };
    const router = createAiRouter({ config: pinnedAi(), providers: [createProvider(transport)], usage: null });
    const result = await runAiReview(getDb(), { router, interests, pipeline, logger: quietLogger, limit: 10 });
    expect(result).toMatchObject({ reviewed: 2, failed: 0 });
    expect(result.stats.droppedQuote).toBe(1);
    expect((await listSignalsOfJob(getDb(), good)).find((row) => row.tier === "ai_tools")).toMatchObject({ quote: "Every engineer gets an uncapped budget for Claude and Cursor seats." });
    expect((await listSignalsOfJob(getDb(), bad)).some((row) => row.tier === "ai_tools")).toBe(false);
    await reconcileBonuses(getDb(), interests);
    const bonus = await getDb().execute<{ job_id: string; signal_bonus: number }>(sql`select job_id, signal_bonus from scores order by job_id`);
    const byJob = new Map(Array.from(bonus, (row) => [Number(row.job_id), Number(row.signal_bonus)]));
    expect((byJob.get(good) ?? 0) - (byJob.get(bad) ?? 0)).toBeGreaterThanOrEqual(4);
  });
});
