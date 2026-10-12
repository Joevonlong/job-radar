import fs from "node:fs";
import path from "node:path";

import { desc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";
import { stringify } from "yaml";

import { SCORE_PROMPT_VERSION } from "@/lib/ai/prompts/score";
import { createProvider } from "@/lib/ai/provider";
import { createAiRouter } from "@/lib/ai/router";
import type { AiConfig } from "@/lib/config";
import type { AiTransport, AiTransportRequest } from "@/lib/ai/types";
import { closeDb, getDb, getJobDetail, markScoresStaleExcept, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { resetReasonEvidenceColumnCache } from "@/lib/db/repos/scores";
import { currentPreferencesSnapshotId, recheckGerman, rescoreStale, runScoring, scoreBacklog, scoreJobs, type ScoringDeps, type ScoringProfile } from "@/lib/scoring";
import { REASON_EVIDENCE_VERSION } from "@/lib/scoring/evidence";

import { quietLogger } from "../cycle/helpers";
import { shippedPipeline } from "../pipeline/helpers";
import { aiConfig, answer, examplePreferences, exampleMe } from "../scoring/helpers";

/** Reason sources end to end: the answer, the stored `scores.reason_evidence`, the detail query, and the database before the migration. */
const url = inject("testDatabaseUrl");
const NOW = new Date("2026-10-07T10:00:00Z");
const MIGRATION = path.resolve(import.meta.dirname, "../../drizzle/0032_score_reason_evidence.sql");

const JD = ["We build retrieval systems.", "## Requirements", "- 5+ years of Python", "- Experience with RAG and vector search", "Fluent German (C1) is required."].join("\n");

const withEvidence = (on: boolean): AiConfig =>
  aiConfig((raw) => {
    (raw.scoring as Record<string, unknown>).evidence = { enabled: on, quote_max_chars: 150 };
  });

interface Fake {
  router: ScoringDeps["router"];
  replies: Map<string, string>;
  systems: string[];
}

function fakeAi(config: AiConfig): Fake {
  const replies = new Map<string, string>();
  const systems: string[] = [];
  const transport: AiTransport = {
    id: "claude-cli",
    availability: () => ({ available: true }),
    async call(request: AiTransportRequest) {
      systems.push(request.system);
      const title = /^Title: (.*)$/m.exec(request.user)?.[1] ?? "?";
      return { text: replies.get(title) ?? answer(), model: "fake-model", usage: { tokensIn: 100, tokensOut: 20 } };
    },
  };
  return { router: createAiRouter({ config, providers: [createProvider(transport)], usage: null }), replies, systems };
}

const profile = (): ScoringProfile => ({ me: exampleMe(), preferences: examplePreferences(), meYaml: stringify(exampleMe()), preferencesYaml: stringify(examplePreferences()) });
const deps = (fake: Fake, config: AiConfig): ScoringDeps => ({ db: getDb(), router: fake.router, config, logger: quietLogger, now: () => NOW, loadProfile: async () => profile(), loadBonusCap: () => 15 });
const currentSnapshot = () => currentPreferencesSnapshotId(getDb(), profile());

let counter = 0;
async function addJob(title: string, description: string | null = JD, german = "unknown"): Promise<number> {
  counter += 1;
  const [company] = await getDb().insert(schema.companies).values({ name: `Company ${counter}`, nameNorm: `company ${counter}` }).returning();
  const [job] = await getDb()
    .insert(schema.jobs)
    .values({ companyId: company!.id, title, titleNorm: title.toLowerCase(), description, germanLevelRequired: german, status: "active", firstSeenAt: new Date(NOW.getTime() - 3_600_000) })
    .returning();
  await getDb().insert(schema.scores).values({ jobId: job!.id, profileSnapshotId: await currentSnapshot(), filterResult: "passed" });
  return job!.id;
}

async function latest(jobId: number) {
  const [row] = await getDb().select().from(schema.scores).where(eq(schema.scores.jobId, jobId)).orderBy(desc(schema.scores.id));
  if (!row) throw new Error(`job ${jobId} has no score row`);
  return row;
}

/** The answer with sources: one quote in the JD, one inferred reason, one gap the JD does not state. */
const sourced = (edit: Record<string, unknown> = {}) =>
  answer({
    fit_reasons: [
      { text: "要求 5 年以上 Python，你有 6 年", basis: "jd", quote: "5+ years of Python" },
      { text: "检索方向与你的 RAG 经验相符", basis: "inferred", quote: null },
    ],
    gaps: [{ text: "没写薪资", basis: "unstated", quote: null }],
    ...edit,
  });

const resetTables = () => getDb().execute(sql`truncate table jobs, companies, scores, profile_snapshots, ai_usage restart identity cascade`);

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});

beforeEach(async () => {
  resetReasonEvidenceColumnCache();
  await resetTables();
});

afterAll(async () => {
  await resetTables();
  await closeDb();
});

describe("storing the sources", () => {
  it("stores the source of every reason next to the text arrays, the quote as the JD spells it, with its offset", async () => {
    const id = await addJob("Sourced");
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("Sourced", sourced());
    const result = await runScoring(deps(fake, config), { limit: 5 });
    expect(result).toMatchObject({ scored: 1, evidenceDowngraded: 0 });
    expect(fake.systems[0]).toContain("Reason sources");
    const row = await latest(id);
    expect(row.fitReasons).toEqual(["要求 5 年以上 Python，你有 6 年", "检索方向与你的 RAG 经验相符"]);
    expect(row.gaps).toEqual(["没写薪资"]);
    expect(row.promptVersion).toBe(SCORE_PROMPT_VERSION);
    expect(row.reasonEvidence).toEqual({
      v: REASON_EVIDENCE_VERSION,
      fit: [
        { basis: "jd", quote: "5+ years of Python", offset: JD.indexOf("5+ years of Python") },
        { basis: "inferred", quote: null, offset: null },
      ],
      gaps: [{ basis: "unstated", quote: null, offset: null }],
    });
  });

  it("stores a quote that is not in the JD as inferred, and counts it", async () => {
    const id = await addJob("Invented");
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("Invented", sourced({ fit_reasons: [{ text: "灵活工时", basis: "jd", quote: "Flexible working hours" }] }));
    const result = await runScoring(deps(fake, config), { limit: 5 });
    expect(result.evidenceDowngraded).toBe(1);
    expect((await latest(id)).reasonEvidence).toMatchObject({ fit: [{ basis: "inferred", quote: null, offset: null }] });
  });

  it("stores a quote shorter than quote_min_chars as inferred, and counts it", async () => {
    const id = await addJob("Too short");
    const config = aiConfig((raw) => {
      (raw.scoring as Record<string, unknown>).evidence = { enabled: true, quote_max_chars: 150, quote_min_chars: 8 };
    });
    const fake = fakeAi(config);
    fake.replies.set("Too short", sourced({ fit_reasons: [{ text: "Python", basis: "jd", quote: "Python" }, { text: "多年 Python", basis: "jd", quote: "5+ years of Python" }] }));
    const result = await runScoring(deps(fake, config), { limit: 5 });
    expect(result.evidenceDowngraded).toBe(1);
    expect((await latest(id)).reasonEvidence).toMatchObject({ fit: [{ basis: "inferred", quote: null }, { basis: "jd", quote: "5+ years of Python" }] });
  });

  it("scores a near-miss answer instead of failing it: an over-long quote is cut, extra keys and non-reasons are dropped", async () => {
    const id = await addJob("Near miss");
    const config = aiConfig((raw) => {
      (raw.scoring as Record<string, unknown>).evidence = { enabled: true, quote_max_chars: 20, quote_min_chars: 8 };
    });
    const fake = fakeAi(config);
    fake.replies.set(
      "Near miss",
      sourced({ fit_reasons: [{ text: "RAG 经验", basis: "jd", quote: "Experience with RAG and vector search", offset: 3 }, 42, { text: "资深", basis: "guess" }], gaps: [{ text: "没写薪资", basis: "unstated" }] }),
    );
    const result = await runScoring(deps(fake, config), { limit: 5 });
    expect(result).toMatchObject({ scored: 1, failed: 0 });
    const row = await latest(id);
    expect(row.fitReasons).toEqual(["RAG 经验", "资深"]);
    expect(row.reasonEvidence).toMatchObject({
      fit: [{ basis: "jd", quote: "Experience with RAG", offset: JD.indexOf("Experience with RAG") }, { basis: null, quote: null }],
      gaps: [{ basis: "unstated", quote: null }],
    });
  });

  it("takes an answer in the old shape (plain strings) as reasons without a source", async () => {
    const id = await addJob("Old shape");
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("Old shape", answer());
    expect(await runScoring(deps(fake, config), { limit: 5 })).toMatchObject({ scored: 1, failed: 0 });
    const row = await latest(id);
    expect(row.fitReasons).toEqual(["匹配理由一", "匹配理由二"]);
    expect(row.reasonEvidence).toMatchObject({ fit: [{ basis: null }, { basis: null }], gaps: [{ basis: null }] });
  });

  it("with sources off: the prompt has no source block, nothing is stored, and a re-score clears old sources", async () => {
    const id = await addJob("Toggle");
    const on = withEvidence(true);
    const fakeOn = fakeAi(on);
    fakeOn.replies.set("Toggle", sourced());
    await runScoring(deps(fakeOn, on), { limit: 5 });
    expect((await latest(id)).reasonEvidence).not.toBeNull();

    await markScoresStaleExcept(getDb(), 987654321);
    const off = withEvidence(false);
    const fakeOff = fakeAi(off);
    const result = await rescoreStale(deps(fakeOff, off));
    expect(result.scored).toBe(1);
    expect(fakeOff.systems[0]).not.toContain("Reason sources");
    const row = await latest(id);
    expect(row.reasonEvidence).toBeNull();
    expect(row.fitReasons).toEqual(["匹配理由一", "匹配理由二"]);
  });

  it("every scoring path writes the sources: the cycle run, the backlog, chosen jobs and stale re-scores", async () => {
    const config = withEvidence(true);
    const fake = fakeAi(config);
    for (const title of ["Backlog", "Chosen", "Stale"]) fake.replies.set(title, sourced());
    const stale = await addJob("Stale");
    await runScoring(deps(fake, config), { limit: 5 });
    await getDb().update(schema.scores).set({ reasonEvidence: null }).where(eq(schema.scores.jobId, stale));
    await markScoresStaleExcept(getDb(), 987654321);
    await rescoreStale(deps(fake, config));
    const backlog = await addJob("Backlog");
    await scoreBacklog(deps(fake, config));
    const chosen = await addJob("Chosen");
    await scoreJobs(deps(fake, config), [chosen]);
    for (const id of [stale, backlog, chosen]) expect((await latest(id)).reasonEvidence).toMatchObject({ fit: [{ basis: "jd", quote: "5+ years of Python" }, { basis: "inferred" }] });
  });
});

describe("nothing is re-scored", () => {
  it("turning sources on or off marks no score stale", async () => {
    await addJob("Scored before");
    const off = withEvidence(false);
    await runScoring(deps(fakeAi(off), off), { limit: 5 });
    const on = withEvidence(true);
    expect((await runScoring(deps(fakeAi(on), on), { limit: 0 })).staleByPromptVersion).toBe(0);
    expect((await runScoring(deps(fakeAi(off), off), { limit: 0 })).staleByPromptVersion).toBe(0);
  });

  it("the German re-check keeps the stored sources", async () => {
    const id = await addJob("German", JD, "C1");
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("German", sourced({ score: 60, german_level_required: "unknown" }));
    await runScoring(deps(fake, config), { limit: 5 });
    const before = (await latest(id)).reasonEvidence;
    expect(before).not.toBeNull();
    await getDb().update(schema.jobs).set({ germanLevelRequired: "none" }).where(eq(schema.jobs.id, id));
    const recheck = await recheckGerman(getDb(), { me: exampleMe(), penalties: config.scoring.language_penalty, bonusCap: 15, pipeline: shippedPipeline() });
    expect(recheck.updated).toBe(1);
    expect((await latest(id)).reasonEvidence).toEqual(before);
  });
});

describe("the detail page", () => {
  it("gets the parsed sources, and none for a score without them", async () => {
    const sourcedId = await addJob("Detail sourced");
    const legacyId = await addJob("Detail legacy");
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("Detail sourced", sourced());
    await runScoring(deps(fake, config), { limit: 5 });
    await getDb().update(schema.scores).set({ reasonEvidence: null }).where(eq(schema.scores.jobId, legacyId));
    expect((await getJobDetail(getDb(), sourcedId))?.score?.reasonEvidence).toMatchObject({ fit: [{ basis: "jd", quote: "5+ years of Python" }, { basis: "inferred" }], gaps: [{ basis: "unstated" }] });
    expect((await getJobDetail(getDb(), legacyId))?.score?.reasonEvidence).toBeNull();
  });

  it("shows no sources when the stored ones do not line up with the reasons", async () => {
    const id = await addJob("Mismatch");
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("Mismatch", sourced());
    await runScoring(deps(fake, config), { limit: 5 });
    await getDb().update(schema.scores).set({ fitReasons: ["only one"] }).where(eq(schema.scores.jobId, id));
    const detail = await getJobDetail(getDb(), id);
    expect(detail?.score?.fitReasons).toEqual(["only one"]);
    expect(detail?.score?.reasonEvidence).toBeNull();
  });
});

describe("before and after the migration", () => {
  const dropColumn = () => getDb().execute(sql`alter table scores drop column if exists reason_evidence`);
  const migrate = () => getDb().execute(sql.raw(fs.readFileSync(MIGRATION, "utf8").replaceAll("--> statement-breakpoint", "")));

  it("the migration adds a nullable column and leaves existing scores as they were", async () => {
    const id = await addJob("Existing");
    const off = withEvidence(false);
    await runScoring(deps(fakeAi(off), off), { limit: 5 });
    await dropColumn();
    resetReasonEvidenceColumnCache();
    try {
      const [before] = await getDb().execute<Record<string, unknown>>(sql`select * from scores where job_id = ${id}`);
      await migrate();
      const [after] = await getDb().execute<Record<string, unknown>>(sql`select * from scores where job_id = ${id}`);
      expect(after).toEqual({ ...before, reason_evidence: null });
      const [column] = await getDb().execute<{ is_nullable: string; data_type: string }>(sql`
        select is_nullable, data_type from information_schema.columns where table_name = 'scores' and column_name = 'reason_evidence'`);
      expect(column).toEqual({ is_nullable: "YES", data_type: "jsonb" });
    } finally {
      await getDb().execute(sql`alter table scores add column if not exists reason_evidence jsonb`);
      resetReasonEvidenceColumnCache();
    }
  });

  it("an ai-worker running before the migration still scores and the detail page still loads, without sources", async () => {
    const id = await addJob("Early worker");
    await dropColumn();
    resetReasonEvidenceColumnCache();
    try {
      const config = withEvidence(true);
      const fake = fakeAi(config);
      fake.replies.set("Early worker", sourced());
      const result = await runScoring(deps(fake, config), { limit: 5 });
      expect(result).toMatchObject({ scored: 1, failed: 0 });
      const [row] = await getDb().execute<{ score: number; fit_reasons: string[] }>(sql`select score, fit_reasons from scores where job_id = ${id} and score is not null`);
      expect(row?.fit_reasons).toEqual(["要求 5 年以上 Python，你有 6 年", "检索方向与你的 RAG 经验相符"]);
      const detail = await getJobDetail(getDb(), id);
      expect(detail?.score).toMatchObject({ score: 80, reasonEvidence: null });
    } finally {
      await getDb().execute(sql`alter table scores add column if not exists reason_evidence jsonb`);
    }
    // once migrated, the next score stores its sources (the probe does not cache a missing column)
    await markScoresStaleExcept(getDb(), 987654321);
    const config = withEvidence(true);
    const fake = fakeAi(config);
    fake.replies.set("Early worker", sourced());
    await rescoreStale(deps(fake, config));
    expect((await latest(id)).reasonEvidence).toMatchObject({ fit: [{ basis: "jd" }, { basis: "inferred" }] });
  });
});
