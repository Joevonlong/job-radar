import fs from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, expect, inject, it, vi } from "vitest";

import { registerFixtureChannel } from "@/lib/channels/fixture";
import { createLinkedinGuestChannel } from "@/lib/channels/jobspy";
import { ChannelRegistry } from "@/lib/channels/registry";
import { closeDb, createConnection, getDb, upsertRawPostings } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import { findJobByFamilyExternalId } from "@/lib/db/repos/jobs";
import { databaseTestSupport, lockTestRawPosting } from "@/lib/db/test-support";
import { runPipeline } from "@/lib/pipeline";

import { httpResponse, jobspyContext, jobspySettings, query } from "../channels/jobspy/helpers";
import { makeTempConfig, type TempConfig } from "../config/helpers";
import { quietLogger } from "../cycle/helpers";
import { shippedPipeline } from "../pipeline/helpers";

const url = inject("testDatabaseUrl");
const data = () => databaseTestSupport(getDb());
let temp: TempConfig;
beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations();
});
beforeEach(() => { temp = makeTempConfig(); });
afterEach(() => { temp.cleanup(); });
afterAll(() => closeDb());

it("migrates legacy guest ids without losing payloads, links or partially upgraded rows", async () => {
  await data().insertChannels([
    { id: "linkedin-guest", family: "linkedin", kind: "guest" },
    { id: "indeed", family: "indeed", kind: "guest" },
  ]);
  await upsertRawPostings(getDb(), { channelId: "linkedin-guest", runId: null, items: ["li-1001", "li-1002", "1002"].map((id) => ({ externalId: id, url: null, payload: { id, title: "original" } })) });
  await upsertRawPostings(getDb(), { channelId: "indeed", runId: null, items: [{ externalId: "li-1003", url: null, payload: { id: "li-1003" } }] });
  const before = await data().rawPostings();
  const [company] = await data().insertCompany({ name: "Example", nameNorm: "example" });
  const [job] = await data().insertJob({ companyId: company!.id, title: "Engineer", titleNorm: "engineer" });
  await data().insertSources(before.filter((raw) => raw.externalId.startsWith("li-") && raw.channelId === "linkedin-guest").map((raw) => ({ jobId: job!.id, rawPostingId: raw.id, channelId: raw.channelId, priority: 1 })));
  const sources = await data().sources();
  const migration = fs.readFileSync(path.resolve(import.meta.dirname, "../../drizzle/0038_job_identity.sql"), "utf8");
  for (let repeat = 0; repeat < 2; repeat += 1) {
    await data().applyIdentityMigration(migration);
  }
  const after = await data().rawPostings();
  expect(after.map((raw) => raw.externalId)).toEqual(["1001", "li-1002", "1002", "li-1003"]);
  expect(after.map((raw, index) => ({ ...raw, externalId: before[index]!.externalId }))).toEqual(before);
  expect(await data().sources()).toEqual(sources);
  expect(await findJobByFamilyExternalId(getDb(), { family: "linkedin", externalId: "1002", excludeRawPostingId: before[2]!.id })).toMatchObject({ id: job!.id });
  expect(await findJobByFamilyExternalId(getDb(), { family: "indeed", externalId: "1002", excludeRawPostingId: 0 })).toBeNull();
});

it("files a LinkedIn guest posting and its session spelling under one job despite different titles", async () => {
  const registry = new ChannelRegistry();
  const fixture = { id: "4476000001", company: "Example Labs", title: "Backend Engineer", city: "Testville", country: "DE", description: "", remote: false, posted_at: null, url: "https://www.linkedin.com/jobs/view/4476000001" };
  registerFixtureChannel(registry, { id: "linkedin-session", family: "linkedin", postings: [fixture] });
  const guest = createLinkedinGuestChannel({ settings: () => jobspySettings() });
  registry.register(guest);
  await data().insertChannels(registry.list().map((channel) => ({ id: channel.id, family: channel.family, kind: channel.kind })));
  const opts = { config: shippedPipeline(), registry, logger: quietLogger };
  await upsertRawPostings(getDb(), { channelId: "linkedin-session", runId: null, items: [{ externalId: fixture.id, url: fixture.url, payload: fixture }] });
  expect((await runPipeline(getDb(), opts)).created).toBe(1);

  const { ctx } = jobspyContext(() => httpResponse(200, { site: "linkedin", count: 1, jobs: [{ site: "linkedin", id: "li-4476000001", title: "Platform Engineer", company: fixture.company, job_url: fixture.url, location: "Othercity, Germany", description: null }] }));
  const raw = await guest.collect(query(), ctx);
  await upsertRawPostings(getDb(), { channelId: guest.id, runId: null, items: raw });
  const result = await runPipeline(getDb(), opts);
  expect(result).toMatchObject({ created: 0, merged: { same_source: 1 } });
  expect(await data().jobs()).toHaveLength(1);
  expect(await data().sources()).toHaveLength(2);
  expect(raw[0]?.externalId).toBe(fixture.id);
  expect(raw[0]?.payload).toMatchObject({ id: "li-4476000001" });
});

it("two pipelines waiting on the same pending posting commit one job and one source", async () => {
  const registry = new ChannelRegistry();
  const fixture = { id: "shared", company: "Example Labs", title: "Engineer", city: "Testville", country: "DE", description: "", remote: false, posted_at: null, url: "https://jobs.example.test/shared" };
  registerFixtureChannel(registry, { id: "fx-concurrent", family: "ats", postings: [fixture] });
  await data().insertChannels([{ id: "fx-concurrent", family: "ats", kind: "ats" }]);
  await data().insertCompany({ name: fixture.company, nameNorm: "example-labs" });
  await upsertRawPostings(getDb(), { channelId: "fx-concurrent", runId: null, items: [{ externalId: fixture.id, url: fixture.url, payload: fixture }] });
  const [raw] = await data().rawPostings();
  const blocker = createConnection(url, { max: 1 });
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered = () => {};
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const held = blocker.db.transaction(async (tx) => {
    await lockTestRawPosting(tx, raw!.id);
    entered();
    await gate;
  });
  await ready;
  const opts = { config: shippedPipeline(), registry, logger: quietLogger };
  const pending = Promise.all([runPipeline(getDb(), opts), runPipeline(getDb(), opts)]);
  let results: Awaited<typeof pending> | undefined;
  try {
    await vi.waitFor(async () => {
      expect(await data().pipelineLockWaiters()).toBe(2);
    }, { timeout: 10_000 });
  } finally {
    release();
    await held;
    results = await pending;
    await blocker.sql.end({ timeout: 5 });
  }
  expect(results?.reduce((sum, result) => sum + result.created, 0)).toBe(1);
  expect(results?.reduce((sum, result) => sum + result.parsed, 0)).toBe(1);
  expect(results?.every((result) => result.deferred === 0)).toBe(true);
  expect(await data().jobs()).toHaveLength(1);
  expect(await data().sources()).toHaveLength(1);
  expect((await data().rawPostings())[0]?.parseStatus).toBe("parsed");
});

