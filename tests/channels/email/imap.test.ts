import { afterEach, describe, expect, it } from "vitest";

import { ChannelError } from "@/lib/channels/errors";
import { classifyImapError, openImapSession, type ImapConnectOptions } from "@/lib/channels/email";

import { buildEml, fixtureHtml } from "./helpers";
import { startFakeImapServer, type FakeImapServer } from "./fake-imap-server";

let server: FakeImapServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const DATE = new Date("2026-10-06T08:30:00Z");
const messages = [1, 2].map((uid) => {
  const spec = { from: "alert@indeed.com", subject: `Alert ${uid}`, messageId: `<m${uid}@alerts.example.test>`, date: DATE, html: fixtureHtml("indeed-alert-en") };
  return { uid, ...spec, source: buildEml(spec) };
});

function options(port: number, overrides: Partial<ImapConnectOptions> = {}): ImapConnectOptions {
  return { host: "127.0.0.1", port, secure: false, user: "radar.test@example.test", password: "app-password-1", label: "JobAlerts", timeoutMs: 5000, signal: new AbortController().signal, ...overrides };
}

describe("openImapSession against an in-process IMAP server (imapflow, no network)", () => {
  it("opens the label read-only (EXAMINE), lists headers newest first and reads whole messages; nothing else is ever sent", async () => {
    server = await startFakeImapServer({ mailbox: "JobAlerts", messages, password: "app-password-1" });
    const session = await openImapSession(options(server.port));
    const headers = await session.listSince(new Date("2026-10-01T00:00:00Z"));
    expect(headers).toEqual([
      { uid: 2, messageId: "<m2@alerts.example.test>", from: "alert@indeed.com", subject: "Alert 2", receivedAt: DATE },
      { uid: 1, messageId: "<m1@alerts.example.test>", from: "alert@indeed.com", subject: "Alert 1", receivedAt: DATE },
    ]);
    const source = await session.fetchSource(1);
    expect(source?.toString("utf8")).toContain("Message-ID: <m1@alerts.example.test>");
    await session.close();

    const verbs = server.commands.map((c) => (c.startsWith("UID ") ? c.split(" ").slice(0, 2).join(" ") : c.split(" ")[0]));
    expect(verbs).toContain("EXAMINE");
    expect(verbs).not.toContain("SELECT");
    // the only commands that touch messages are read-only searches and fetches
    const mutating = verbs.filter((v) => /^(?:STORE|UID STORE|COPY|UID COPY|MOVE|UID MOVE|EXPUNGE|UID EXPUNGE|APPEND|DELETE|CREATE|RENAME|SUBSCRIBE)$/.test(v ?? ""));
    expect(mutating).toEqual([]);
    // bodies are requested with PEEK (never BODY[], which would set \Seen on a writable mailbox)
    const bodyFetches = server.commands.filter((c) => c.includes("BODY"));
    expect(bodyFetches.length).toBeGreaterThan(0);
    for (const command of bodyFetches) expect(command).toContain("BODY.PEEK[]");
    expect(server.commands.some((c) => /\bSINCE\b/i.test(c))).toBe(true);
  });

  it("a wrong app password is auth_expired and the message does not echo the password", async () => {
    server = await startFakeImapServer({ mailbox: "JobAlerts", messages, password: "app-password-1" });
    const error = await openImapSession(options(server.port, { password: "wrong-secret-xyz" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "auth_expired", retryable: false });
    expect((error as Error).message).not.toContain("wrong-secret-xyz");
  });

  it("a label that does not exist is a non-retryable error that names the config key", async () => {
    server = await startFakeImapServer({ mailbox: "JobAlerts", messages });
    const error = await openImapSession(options(server.port, { label: "Missing" })).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ChannelError);
    expect(error).toMatchObject({ code: "unknown", retryable: false });
    expect((error as Error).message).toContain("sources.gmail.label");
  });

  it("a server that is not there is a retryable network error", async () => {
    server = await startFakeImapServer({ mailbox: "JobAlerts", messages });
    const port = server.port;
    await server.close();
    server = null;
    const error = await openImapSession(options(port)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "network", retryable: true });
  });

  it("an empty search result gives no headers", async () => {
    server = await startFakeImapServer({ mailbox: "JobAlerts", messages: [] });
    const session = await openImapSession(options(server.port));
    expect(await session.listSince(new Date(0))).toEqual([]);
    await session.close();
  });
});

describe("classifyImapError", () => {
  it("maps imapflow errors to channel errors without leaking server text", () => {
    expect(classifyImapError({ authenticationFailed: true, response: "secret" })).toMatchObject({ code: "auth_expired" });
    expect(classifyImapError({ serverResponseCode: "NONEXISTENT" })).toMatchObject({ code: "unknown", retryable: false });
    expect(classifyImapError({ code: "ETIMEDOUT" })).toMatchObject({ code: "network", retryable: true });
    expect(classifyImapError(new Error("boom with secret"))).toMatchObject({ code: "network" });
    expect(classifyImapError(new Error("boom with secret")).message).not.toContain("secret");
    const own = new ChannelError("parse", "x");
    expect(classifyImapError(own)).toBe(own);
  });
});
