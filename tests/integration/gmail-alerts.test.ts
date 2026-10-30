import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { createDbEmailStore, createGmailAlertsChannel } from "@/lib/channels/email";
import { createFixtureChannel, type FixturePosting } from "@/lib/channels/fixture";
import { ChannelRegistry } from "@/lib/channels/registry";
import { registerBuiltinCycleSteps } from "@/lib/cycle/builtin-steps";
import { runCycle, type RunCycleOptions } from "@/lib/cycle/run-cycle";
import { resetCycleSteps } from "@/lib/cycle/steps";
import { closeDb, getDb, listJobSources, listRawPostingsForChannel, listRunsForCycle, schema } from "@/lib/db";
import { runMigrations } from "@/lib/db/migrate";
import type { PipelineResult } from "@/lib/pipeline";

import { makeTempConfig, type TempConfig } from "../config/helpers";
import { ENV, NOW, buildEml, fakeMailbox, fixtureMessages, gmailChannels, type FakeMailbox, type FakeMessage } from "../channels/email/helpers";
import { config, quietLogger } from "../cycle/helpers";

const url = inject("testDatabaseUrl");

const resetTables = () =>
  getDb().execute(sql`truncate table jobs, companies, raw_postings, runs, cycles, channels, email_messages restart identity cascade`);

let temp: TempConfig;

beforeAll(async () => {
  process.env.DATABASE_URL = url;
  await runMigrations({ currentScoresBackfill: { lockTimeoutMs: 3000, statementTimeoutMs: 60000 } });
});

beforeEach(async () => {
  temp = makeTempConfig(); // the `filter` step reads the profile files
  await resetTables();
  registerBuiltinCycleSteps();
});

afterEach(() => {
  resetCycleSteps();
  temp.cleanup();
});

afterAll(async () => {
  await resetTables();
  await closeDb();
});

function emailRegistry(box: FakeMailbox, extra: (registry: ChannelRegistry) => void = () => {}): ChannelRegistry {
  const registry = new ChannelRegistry();
  registry.register(createGmailAlertsChannel({ connect: box.factory, store: () => createDbEmailStore(getDb()), environment: ENV, now: () => NOW }));
  extra(registry);
  return registry;
}

function cycle(registry: ChannelRegistry, options: RunCycleOptions = {}) {
  return runCycle("manual", { registry, config: { ...config(), channels: gmailChannels() }, logger: quietLogger, sleep: async () => {}, ...options });
}

const pipelineOf = (result: Awaited<ReturnType<typeof cycle>>) => result.results.pipeline as PipelineResult;

describe("gmail-alerts through a full cycle", () => {
  it("reads the label read-only, stores every card verbatim, isolates parse failures and creates jobs from the rest", async () => {
    const box = fakeMailbox(fixtureMessages());
    const first = await cycle(emailRegistry(box));
    expect(first.status).toBe("succeeded");

    const [run] = await listRunsForCycle(getDb(), first.cycleId as number);
    expect(run).toMatchObject({ channelId: "gmail-alerts", status: "succeeded", fetched: 21, newCount: 21 });
    expect(box.opened).toEqual([{ label: "JobAlerts", user: ENV.GMAIL_USER, host: "imap.gmail.com" }]);
    expect(box.closed).toBe(1);

    const raws = await listRawPostingsForChannel(getDb(), "gmail-alerts");
    expect(raws).toHaveLength(21);
    expect(raws.find((r) => r.externalId === "stepstone:11234567")?.payloadJson).toMatchObject({
      kind: "email_job",
      platform: "stepstone",
      job: { title: "Machine Learning Engineer (m/w/d)", company: "Nordwind Robotics GmbH", location: "Berlin" },
    });

    // one XING card has no company: only that posting is parse_failed, with a readable reason
    const failed = raws.filter((r) => r.parseStatus === "parse_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ externalId: "xing:133445700" });
    expect(failed[0]?.parseError).toMatch(/has no company/);
    expect(pipelineOf(first)).toMatchObject({ processed: 21, parsed: 20, parseFailed: 1, aborted: false });

    const messages = await getDb().select().from(schema.emailMessages);
    expect(messages).toHaveLength(8);
    expect(messages.every((m) => m.parseStatus === "parsed" && m.rawRef?.startsWith("imap:JobAlerts#uid="))).toBe(true);
    expect((await getDb().select().from(schema.jobs)).length).toBeGreaterThan(10);
    const sources = await getDb().select().from(schema.jobSources);
    expect(sources.every((s) => s.channelId === "gmail-alerts" && s.priority === 4)).toBe(true);
  });

  it("does not read the same emails again in the next cycle (Message-ID dedupe survives the process)", async () => {
    await cycle(emailRegistry(fakeMailbox(fixtureMessages())));
    const rawBefore = await listRawPostingsForChannel(getDb(), "gmail-alerts");

    const again = fakeMailbox(fixtureMessages());
    const second = await cycle(emailRegistry(again));
    expect(again.calls.filter((c) => c.startsWith("fetchSource"))).toEqual([]);
    const [run] = await listRunsForCycle(getDb(), second.cycleId as number);
    expect(run).toMatchObject({ status: "succeeded", fetched: 0, newCount: 0 });
    expect(await listRawPostingsForChannel(getDb(), "gmail-alerts")).toHaveLength(rawBefore.length);
  });

  it("a new email in a later cycle is picked up on its own", async () => {
    const all = fixtureMessages();
    const [newest, ...older] = all as [FakeMessage, ...FakeMessage[]];
    await cycle(emailRegistry(fakeMailbox(older)));
    const second = fakeMailbox(all);
    await cycle(emailRegistry(second));
    expect(second.calls.filter((c) => c.startsWith("fetchSource"))).toEqual([`fetchSource ${newest.uid}`]);
    expect(await getDb().select().from(schema.emailMessages)).toHaveLength(8);
  });

  it("stores an email whose layout no parser reads whole (raw HTML), marks it parse_failed, and still processes the others", async () => {
    const odd: FakeMessage = {
      uid: 900,
      from: "jobalerts-noreply@linkedin.com",
      subject: "A redesigned alert",
      messageId: "<redesign@alerts.example.test>",
      date: new Date(NOW.getTime() - 60_000),
      html: "<html><body><div class='new-layout'><p>Brand new layout with a card nobody knows</p></div></body></html>",
    };
    const result = await cycle(emailRegistry(fakeMailbox([odd, ...fixtureMessages().slice(2, 3)])));
    expect(result.status).toBe("succeeded");

    const raws = await listRawPostingsForChannel(getDb(), "gmail-alerts");
    const bad = raws.find((r) => r.externalId.startsWith("unparsed:"));
    expect(bad).toMatchObject({ parseStatus: "parse_failed", url: null });
    expect(bad?.payloadJson).toMatchObject({ kind: "email_unparsed", subject: "A redesigned alert", html: expect.stringContaining("Brand new layout") });
    expect(bad?.parseError).toMatch(/no linkedin job cards recognised/);
    expect(raws.filter((r) => r.parseStatus === "parsed")).toHaveLength(3);

    const stored = await getDb().select().from(schema.emailMessages).where(eq(schema.emailMessages.messageId, "<redesign@alerts.example.test>"));
    expect(stored).toEqual([expect.objectContaining({ parseStatus: "parse_failed", sender: "jobalerts-noreply@linkedin.com" })]);
  });

  it("a mailbox failure fails only this channel's run (auth), records nothing, and the other channel is unaffected", async () => {
    const boom = fakeMailbox([], { failConnect: Object.assign(new Error("login refused"), { authenticationFailed: true }) });
    const posting: FixturePosting = { id: "a1", title: "Platform Engineer", company: "Solo GmbH", city: "Berlin", country: "DE", remote: false, description: "x", url: "https://jobs.example.test/a1", posted_at: null };
    const result = await cycle(
      emailRegistry(boom, (registry) =>
        registry.register(createFixtureChannel({ id: "fx-ats", family: "ats", kind: "ats", usesQueries: false, postings: [posting] }), {
          settings: { enabled: true, maxResults: 50, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} },
        }),
      ),
    );
    expect(result.status).toBe("partial");
    const runs = await listRunsForCycle(getDb(), result.cycleId as number);
    expect(runs.find((r) => r.channelId === "gmail-alerts")).toMatchObject({ status: "failed", errorCode: "auth_expired" });
    expect(runs.find((r) => r.channelId === "fx-ats")).toMatchObject({ status: "succeeded", fetched: 1 });
    expect(await getDb().select().from(schema.emailMessages)).toHaveLength(0);
    expect((await listRawPostingsForChannel(getDb(), "fx-ats")).length).toBe(1);
  });

  it("a dry run reads the mailbox and writes nothing", async () => {
    const box = fakeMailbox(fixtureMessages());
    const result = await cycle(emailRegistry(box), { dryRun: true });
    expect(result.status).toBe("succeeded");
    expect(box.calls.filter((c) => c.startsWith("fetchSource"))).toHaveLength(8);
    expect(await getDb().select().from(schema.emailMessages)).toHaveLength(0);
    expect(await getDb().select().from(schema.rawPostings)).toHaveLength(0);
  });
});

describe("cross-source merge", () => {
  it("the same job from the company ATS and a LinkedIn alert email is one job with two sources; the ATS link is the apply link", async () => {
    const posting: FixturePosting = {
      id: "ats-1",
      title: "Machine Learning Engineer (m/w/d)",
      company: "Nordwind Robotics GmbH",
      city: "Berlin",
      country: "DE",
      remote: false,
      description: "Build ML systems for robots. ".repeat(10),
      url: "https://jobs.example.test/nordwind/ats-1",
      posted_at: "2026-10-05T08:00:00Z",
    };
    const only = fixtureMessages().slice(0, 1); // the English LinkedIn digest
    const result = await cycle(
      emailRegistry(fakeMailbox(only), (registry) =>
        registry.register(createFixtureChannel({ id: "fx-ats", family: "ats", kind: "ats", usesQueries: false, postings: [posting] }), {
          settings: { enabled: true, maxResults: 50, monthlyBudgetUsd: 0, freeRecordsPerMonth: 0, throttle: { minDelayMs: 0, maxDelayMs: 0 }, extra: {} },
        }),
      ),
    );
    expect(result.status).toBe("succeeded");

    const jobs = await getDb().select().from(schema.jobs);
    const nordwind = jobs.filter((j) => j.titleNorm === "machine learning engineer");
    expect(nordwind).toHaveLength(1);
    const sources = await listJobSources(getDb(), nordwind[0]?.id as number);
    expect(sources.map((s) => [s.channelId, s.priority])).toEqual([
      ["fx-ats", 1],
      ["gmail-alerts", 4],
    ]);
    expect(sources[1]?.url).toBe("https://www.linkedin.com/jobs/view/3945123456/");
    expect(nordwind[0]).toMatchObject({ title: "Machine Learning Engineer (m/w/d)", workplace: "hybrid" }); // the ATS posting wins the fields; the email fills the one it states
  });
});

describe("email_messages", () => {
  it("message ids are unique: recording the same message twice keeps the first outcome", async () => {
    const store = createDbEmailStore(getDb());
    const row = { messageId: "<dup@x>", sender: "a@linkedin.com", receivedAt: NOW, parseStatus: "parsed" as const, rawRef: "imap:JobAlerts#uid=1" };
    await store.record([row]);
    await store.record([{ ...row, parseStatus: "parse_failed" }]);
    expect(await getDb().select().from(schema.emailMessages)).toEqual([expect.objectContaining({ messageId: "<dup@x>", parseStatus: "parsed" })]);
    expect(await store.findProcessed(["<dup@x>", "<other@x>"])).toEqual(new Set(["<dup@x>"]));
  });

  it("the fake mailbox encodes a real MIME message (guards the helper the tests rely on)", () => {
    expect(buildEml({ from: "a@b.test", subject: "s", messageId: "<1@x>", date: NOW, html: "<p>hi</p>" }).toString("utf8")).toContain("Message-ID: <1@x>");
  });
});
