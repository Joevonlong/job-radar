import { describe, expect, it } from "vitest";

import { createGmailAlertsChannel, createMemoryEmailStore, type EmailStore } from "@/lib/channels/email";
import { ChannelError } from "@/lib/channels/errors";
import { normalizedPostingDraftSchema, rawPostingInputSchema, type Channel } from "@/lib/channels/types";

import { ENV, NOW, emailContext, fakeMailbox, fixtureHtml, fixtureMessages, gmailChannels, type FakeMessage, type FakeMailbox } from "./helpers";

function channelWith(box: FakeMailbox, store: EmailStore = createMemoryEmailStore(), environment: Record<string, string | undefined> = ENV): Channel {
  return createGmailAlertsChannel({ connect: box.factory, store: () => store, environment, now: () => NOW });
}

const message = (uid: number, overrides: Partial<FakeMessage> = {}): FakeMessage => ({
  uid,
  from: "alert@indeed.com",
  subject: `alert ${uid}`,
  messageId: `<m${uid}@alerts.example.test>`,
  date: new Date(NOW.getTime() - uid * 3_600_000),
  html: fixtureHtml("indeed-alert-en"),
  ...overrides,
});

describe("gmail-alerts channel identity", () => {
  it("declines automatic catch-up because mailbox collection ignores the search window", () => {
    const channel = channelWith(fakeMailbox([]));
    const { ctx } = emailContext();
    expect(channel.supportsCatchUp?.(ctx.settings)).toBe(false);
  });

  it("is an email-family, email-kind channel without keyword queries", () => {
    const channel = channelWith(fakeMailbox([]));
    expect(channel).toMatchObject({ id: "gmail-alerts", family: "email", kind: "email", usesQueries: false });
  });
});

describe("collect", () => {
  it("reads the configured label, turns every fixture email into raw postings and records the messages", async () => {
    const box = fakeMailbox(fixtureMessages());
    const store = createMemoryEmailStore();
    const { ctx, query } = emailContext();
    const postings = await channelWith(box, store).collect(query, ctx);

    expect(box.opened).toEqual([{ label: "JobAlerts", user: ENV.GMAIL_USER, host: "imap.gmail.com" }]);
    expect(box.closed).toBe(1);
    expect(postings).toHaveLength(3 + 3 + 3 + 2 + 3 + 2 + 3 + 2);
    for (const posting of postings) expect(rawPostingInputSchema.safeParse(posting).success).toBe(true);
    expect(new Set(postings.map((p) => p.externalId)).size).toBe(postings.length);
    expect(postings.map((p) => p.externalId)).toEqual(
      expect.arrayContaining(["linkedin:3945123456", "stepstone:11234567", "indeed:8f2c6a1b9d3e4f70", "xing:122334455"]),
    );
    expect(postings.find((p) => p.externalId === "linkedin:3945123456")).toMatchObject({
      url: "https://www.linkedin.com/jobs/view/3945123456/",
      payload: { kind: "email_job", platform: "linkedin", job: { title: "Machine Learning Engineer (m/w/d)", company: "Nordwind Robotics GmbH" } },
    });
    // a sponsored Indeed link has no id: its cleaned link is the external id
    expect(postings.some((p) => p.externalId.startsWith("indeed:https://de.indeed.com/pagead/clk?"))).toBe(true);

    expect([...store.rows.values()].map((r) => [r.messageId, r.parseStatus, r.sender, r.rawRef]).sort()).toEqual(
      fixtureMessages()
        .map((m) => [m.messageId, "parsed", m.from, `imap:JobAlerts#uid=${m.uid}`])
        .sort(),
    );
  });

  it("only reads: the session offers no way to change the mailbox, and bodies are fetched one message at a time", async () => {
    const box = fakeMailbox(fixtureMessages());
    const { ctx, query } = emailContext();
    await channelWith(box).collect(query, ctx);
    expect(box.calls.filter((c) => !c.startsWith("listSince") && !c.startsWith("fetchSource"))).toEqual([]);
    expect(box.calls.filter((c) => c.startsWith("fetchSource"))).toHaveLength(8);
  });

  it("reads each Message-ID once: the next cycle neither fetches bodies nor returns postings", async () => {
    const store = createMemoryEmailStore();
    const first = fakeMailbox(fixtureMessages());
    const { ctx, query } = emailContext();
    await channelWith(first, store).collect(query, ctx);

    const second = fakeMailbox(fixtureMessages());
    expect(await channelWith(second, store).collect(query, ctx)).toEqual([]);
    expect(second.calls.filter((c) => c.startsWith("fetchSource"))).toEqual([]);
    expect(second.closed).toBe(1);
  });

  it("a duplicate Message-ID within one mailbox is read once", async () => {
    const box = fakeMailbox([message(1), message(2, { messageId: "<m1@alerts.example.test>" })]);
    const { ctx, query } = emailContext();
    await channelWith(box).collect(query, ctx);
    expect(box.calls.filter((c) => c.startsWith("fetchSource"))).toEqual(["fetchSource 1"]);
  });

  it("an email no parser reads is stored whole as email_unparsed and marked parse_failed; the others still come through", async () => {
    const store = createMemoryEmailStore();
    const box = fakeMailbox([
      message(1),
      message(2, { from: "jobalerts-noreply@linkedin.com", html: "<html><body><p>Your account settings changed.</p></body></html>", messageId: "<odd@alerts.example.test>" }),
    ]);
    const { ctx, query } = emailContext();
    const postings = await channelWith(box, store).collect(query, ctx);

    const unparsed = postings.filter((p) => (p.payload as { kind: string }).kind === "email_unparsed");
    expect(unparsed).toHaveLength(1);
    expect(unparsed[0]).toMatchObject({
      url: null,
      payload: { platform: "linkedin", messageId: "<odd@alerts.example.test>", reason: "no linkedin job cards recognised", html: expect.stringContaining("Your account settings changed.") },
    });
    expect(unparsed[0]?.externalId).toMatch(/^unparsed:[0-9a-f]{24}$/);
    expect(postings.filter((p) => (p.payload as { kind: string }).kind === "email_job")).toHaveLength(3);
    expect(store.rows.get("<odd@alerts.example.test>")?.parseStatus).toBe("parse_failed");
    expect(store.rows.get("<m1@alerts.example.test>")?.parseStatus).toBe("parsed");
  });

  it("an email without an HTML part is kept as unparsed with its text", async () => {
    const box = fakeMailbox([message(1, { html: null, text: "plain only" })]);
    const { ctx, query } = emailContext();
    const [posting] = await channelWith(box).collect(query, ctx);
    expect(posting?.payload).toMatchObject({ kind: "email_unparsed", reason: "no HTML part", html: null, text: "plain only" });
  });

  it("a stray mail from another sender is not fetched or stored, only noted as handled", async () => {
    const store = createMemoryEmailStore();
    const box = fakeMailbox([message(1, { from: "newsletter@example.test" })]);
    const { ctx, query } = emailContext();
    expect(await channelWith(box, store).collect(query, ctx)).toEqual([]);
    expect(box.calls.some((c) => c.startsWith("fetchSource"))).toBe(false);
    expect(store.rows.get("<m1@alerts.example.test>")).toMatchObject({ parseStatus: "parse_failed", sender: "newsletter@example.test" });
  });

  it("an email that vanished before it was read is not recorded", async () => {
    const store = createMemoryEmailStore();
    const box = fakeMailbox([message(1)]);
    const gone = { ...box, factory: async (o: Parameters<FakeMailbox["factory"]>[0]) => ({ ...(await box.factory(o)), fetchSource: async () => null }) };
    const { ctx, query } = emailContext();
    expect(await channelWith(gone, store).collect(query, ctx)).toEqual([]);
    expect(store.rows.size).toBe(0);
  });

  it("a message without Message-ID gets a stable synthetic id", async () => {
    const store = createMemoryEmailStore();
    const { ctx, query } = emailContext();
    const box = fakeMailbox([message(1, { messageId: null })]);
    await channelWith(box, store).collect(query, ctx);
    const [id] = [...store.rows.keys()];
    expect(id).toMatch(/^<no-message-id:[0-9a-f]{32}@job-radar\.invalid>$/);
    expect(await channelWith(fakeMailbox([message(1, { messageId: null })]), store).collect(query, ctx)).toEqual([]);
  });

  it("honours max_messages_per_cycle (newest first); the rest waits for the next cycle", async () => {
    const store = createMemoryEmailStore();
    const channels = gmailChannels((b) => {
      b.max_messages_per_cycle = 2;
    });
    const { ctx, query } = emailContext({ channels });
    const messages = [1, 2, 3, 4, 5].map((n) => message(n));
    const box = fakeMailbox(messages);
    await channelWith(box, store).collect(query, ctx);
    expect(box.calls.filter((c) => c.startsWith("fetchSource"))).toEqual(["fetchSource 1", "fetchSource 2"]);

    const next = fakeMailbox(messages);
    await channelWith(next, store).collect(query, ctx);
    expect(next.calls.filter((c) => c.startsWith("fetchSource"))).toEqual(["fetchSource 3", "fetchSource 4"]);
  });

  it("only looks lookback_days back", async () => {
    const channels = gmailChannels((b) => {
      b.lookback_days = 2;
    });
    const { ctx, query } = emailContext({ channels });
    const box = fakeMailbox([message(1), message(2, { date: new Date(NOW.getTime() - 3 * 86_400_000) })]);
    await channelWith(box).collect(query, ctx);
    expect(box.calls[0]).toBe(`listSince ${new Date(NOW.getTime() - 2 * 86_400_000).toISOString()}`);
    expect(box.calls.filter((c) => c.startsWith("fetchSource"))).toEqual(["fetchSource 1"]);
  });

  it("stops starting new emails once the posting cap is reached, but never cuts an email in half", async () => {
    const { ctx, query } = emailContext();
    const box = fakeMailbox([1, 2, 3].map((n) => message(n)));
    const postings = await channelWith(box).collect({ ...query, maxResults: 4 }, ctx);
    // the indeed fixture holds 3 cards: 3 < 4 so a second email is read completely, then the cap stops the third
    expect(postings).toHaveLength(6);
    expect(box.calls.filter((c) => c.startsWith("fetchSource"))).toHaveLength(2);
  });

  it("dry runs read without consulting or writing the handled-message list", async () => {
    const store = createMemoryEmailStore();
    let asked = 0;
    const spy: EmailStore = { findProcessed: (ids) => (asked++, store.findProcessed(ids)), record: (rows) => store.record(rows) };
    const { ctx, query } = emailContext({ cycleId: null });
    const postings = await channelWith(fakeMailbox([message(1)]), spy).collect(query, ctx);
    expect(postings).toHaveLength(3);
    expect(asked).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  it("never logs the account or the password", async () => {
    const harness = emailContext();
    await channelWith(fakeMailbox(fixtureMessages())).collect(harness.query, harness.ctx);
    const text = JSON.stringify(harness.logs);
    expect(text).not.toContain(ENV.GMAIL_USER);
    expect(text).not.toContain("abcd");
    expect(text).not.toContain("ijkl");
  });
});

describe("collect failures", () => {
  it("is not configured without both credentials, so the runner skips it", () => {
    expect(channelWith(fakeMailbox([])).isConfigured?.()).toBe(true);
    expect(channelWith(fakeMailbox([]), undefined, {}).isConfigured?.()).toBe(false);
    expect(channelWith(fakeMailbox([]), undefined, { GMAIL_USER: ENV.GMAIL_USER }).isConfigured?.()).toBe(false);
  });

  it("without credentials it fails as auth_expired before connecting", async () => {
    const box = fakeMailbox([]);
    const { ctx, query } = emailContext();
    const error = await channelWith(box, createMemoryEmailStore(), {}).collect(query, ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "auth_expired", retryable: false });
    expect((error as Error).message).toContain("GMAIL_APP_PASSWORD");
    expect(box.opened).toEqual([]);
  });

  it("strips the spaces Google shows in an app password", async () => {
    let seen = "";
    const box = fakeMailbox([]);
    const channel = createGmailAlertsChannel({
      connect: async (options) => {
        seen = options.password;
        return box.factory(options);
      },
      store: () => createMemoryEmailStore(),
      environment: ENV,
      now: () => NOW,
    });
    const { ctx, query } = emailContext();
    await channel.collect(query, ctx);
    expect(seen).toBe("abcdefghijklmnop");
  });

  it("a rejected login or an unreachable server surfaces as the classified error", async () => {
    const { ctx, query } = emailContext();
    const auth = new ChannelError("auth_expired", "Gmail rejected the login");
    await expect(channelWith(fakeMailbox([], { failConnect: auth })).collect(query, ctx)).rejects.toBe(auth);
  });

  it("a connection that drops mid-way keeps what was read and leaves the rest for the next cycle", async () => {
    const store = createMemoryEmailStore();
    const { ctx, query } = emailContext();
    const box = fakeMailbox([1, 2, 3].map((n) => message(n)), { failFetchAfter: 1 });
    const postings = await channelWith(box, store).collect(query, ctx);
    expect(postings).toHaveLength(3);
    expect([...store.rows.keys()]).toEqual(["<m1@alerts.example.test>"]);
    expect(box.closed).toBe(1);
  });

  it("a connection that drops before anything was read fails the run as network", async () => {
    const { ctx, query } = emailContext();
    const box = fakeMailbox([message(1)], { failFetchAfter: 0 });
    await expect(channelWith(box).collect(query, ctx)).rejects.toMatchObject({ code: "network" });
    expect(box.closed).toBe(1);
  });

  it("a cancelled cycle aborts and still closes the connection", async () => {
    const controller = new AbortController();
    const { ctx, query } = emailContext({ signal: controller.signal });
    const box = fakeMailbox([message(1), message(2)]);
    controller.abort();
    await expect(channelWith(box).collect(query, ctx)).rejects.toThrow();
    expect(box.closed).toBe(1);
  });

  it("an invalid sources.gmail block is a non-retryable error", async () => {
    const harness = emailContext();
    const broken = { ...harness.ctx, settings: { ...harness.ctx.settings, extra: { enabled: true } } };
    await expect(channelWith(fakeMailbox([])).collect(harness.query, broken)).rejects.toMatchObject({ code: "unknown", retryable: false });
  });
});

describe("parse", () => {
  it("every complete fixture card becomes a valid draft that links to the platform", async () => {
    const box = fakeMailbox(fixtureMessages());
    const { ctx, query } = emailContext();
    const channel = channelWith(box);
    const postings = await channel.collect(query, ctx);

    let parsed = 0;
    let failed = 0;
    for (const posting of postings) {
      try {
        const draft = normalizedPostingDraftSchema.parse(channel.parse(posting.payload));
        expect(draft.sourceUrl).toBe(posting.url);
        expect(draft.applyUrl).toBe(posting.url);
        parsed += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(ChannelError);
        failed += 1;
      }
    }
    // XING "Platform Engineer" has no company: that one card fails on its own (C3: no guessing)
    expect(failed).toBe(1);
    expect(parsed).toBe(postings.length - 1);
  });

  it("maps card fields onto the draft without inventing anything", async () => {
    const channel = channelWith(fakeMailbox([]));
    const draft = channel.parse({
      kind: "email_job",
      platform: "linkedin",
      job: {
        id: "3945123456",
        url: "https://www.linkedin.com/jobs/view/3945123456/",
        title: " Machine Learning Engineer ",
        company: "Nordwind Robotics GmbH",
        location: "Berlin, Berlin, Germany",
        workplace: "hybrid",
        salaryText: "€70K/yr - €90K/yr",
        snippet: null,
      },
    });
    expect(draft).toMatchObject({
      title: "Machine Learning Engineer",
      companyName: "Nordwind Robotics GmbH",
      locations: [{ label: "Berlin, Berlin, Germany", city: null, countryCode: null }],
      workplace: "hybrid",
      salaryText: "€70K/yr - €90K/yr",
      description: "",
      extra: { platform: "linkedin", platformJobId: "3945123456" },
    });
    const bare = channel.parse({ kind: "email_job", platform: "xing", job: { id: null, url: "https://www.xing.com/jobs/x-123456", title: "T", company: "C", location: null, workplace: null, salaryText: null, snippet: "teaser" } });
    expect(bare).toMatchObject({ locations: [], workplace: "unknown", salaryText: null, description: "teaser" });
  });

  it("throws ChannelError(parse) for unparsed emails, cards without company, and foreign payloads", () => {
    const channel = channelWith(fakeMailbox([]));
    const unparsed = { kind: "email_unparsed", platform: "xing", messageId: "<a>", sender: "x", subject: "s", receivedAt: NOW.toISOString(), reason: "no xing job cards recognised", html: "<p/>", text: null };
    expect(() => channel.parse(unparsed)).toThrow(/no xing job cards recognised/);
    const noCompany = { kind: "email_job", platform: "xing", job: { id: "1", url: "https://www.xing.com/jobs/x-123456", title: "T", company: null, location: null, workplace: null, salaryText: null, snippet: null } };
    expect(() => channel.parse(noCompany)).toThrow(/no company/);
    for (const bad of [null, {}, { kind: "email_job" }, "text"]) expect(() => channel.parse(bad)).toThrow(ChannelError);
  });
});

describe("the Gmail login goes only to imap.gmail.com:993 over TLS", () => {
  it.each([
    ["another host", { host: "imap.evil.example" }],
    ["no TLS", { secure: false }],
    ["another port", { port: 143 }],
  ])("refuses %s before connecting, without a retry", async (_label, edit) => {
    const box = fakeMailbox(fixtureMessages());
    const { ctx, query } = emailContext({ channels: gmailChannels((block) => Object.assign(block, edit)) });
    const error = await channelWith(box).collect(query, ctx).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect((error as ChannelError).retryable).toBe(false);
    expect((error as ChannelError).message).toContain("JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1");
    expect(box.opened).toEqual([]);
  });

  it("connects with JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS=1 (a local test server) and warns", async () => {
    const box = fakeMailbox([]);
    const { ctx, query, logs } = emailContext({ channels: gmailChannels((block) => Object.assign(block, { host: "127.0.0.1", port: 3993, secure: false })) });
    await channelWith(box, createMemoryEmailStore(), { ...ENV, JOB_RADAR_ALLOW_CUSTOM_ENDPOINTS: "1" }).collect(query, ctx);
    expect(box.opened).toHaveLength(1);
    expect(logs.some((l) => l.level === "warn" && l.message === "gmail-alerts: custom IMAP endpoint")).toBe(true);
  });
});
