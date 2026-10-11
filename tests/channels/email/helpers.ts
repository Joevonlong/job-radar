import fs from "node:fs";
import path from "node:path";

import { createChannelContext } from "@/lib/channels/context";
import type { MailHeader, MailSession, MailSessionFactory } from "@/lib/channels/email";
import { createLogger, type LogRecord } from "@/lib/channels/logger";
import { buildSweepQuery } from "@/lib/channels/query";
import { settingsFromConfig } from "@/lib/channels/registry";
import type { ChannelContext, SearchQuery } from "@/lib/channels/types";
import { configRegistry, type ChannelsConfig } from "@/lib/config";

import { shippedYaml } from "../../config/helpers";
import { shippedSearch } from "../helpers";

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../../fixtures/email");

export function fixtureHtml(name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `${name}.html`), "utf8");
}

export const ENV = { GMAIL_USER: "radar.test@example.test", GMAIL_APP_PASSWORD: "abcd efgh ijkl mnop" } as const;

export interface EmailSpec {
  from: string;
  subject: string;
  messageId: string | null;
  date: Date;
  html: string | null;
  text?: string;
}

/** A raw RFC 822 message (multipart/alternative, HTML part base64 like the platforms send it). */
export function buildEml(spec: EmailSpec): Buffer {
  const boundary = "----=_Part_job_radar_test";
  const parts: string[] = [
    `From: Platform <${spec.from}>`,
    "To: radar.test@example.test",
    `Subject: ${spec.subject}`,
    `Date: ${spec.date.toUTCString()}`,
    ...(spec.messageId ? [`Message-ID: ${spec.messageId}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 7bit",
    "",
    spec.text ?? "Your job alert (plain text version)",
  ];
  if (spec.html !== null) {
    parts.push(
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: base64",
      "",
      (Buffer.from(spec.html, "utf8").toString("base64").match(/.{1,76}/g) ?? []).join("\r\n"),
    );
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n"), "utf8");
}

export interface FakeMessage extends EmailSpec {
  uid: number;
}

export interface FakeMailbox {
  factory: MailSessionFactory;
  /** Everything the channel asked the mailbox for. */
  calls: string[];
  opened: Array<{ label: string; user: string; host: string }>;
  closed: number;
}

/**
 * An in-process mailbox that implements only the read-only session the channel needs, so any attempt
 * to mutate the mailbox would not even compile. `failFetchAfter` makes the connection drop.
 */
export function fakeMailbox(messages: readonly FakeMessage[], options: { failFetchAfter?: number; failConnect?: unknown } = {}): FakeMailbox {
  const calls: string[] = [];
  const opened: FakeMailbox["opened"] = [];
  const box: FakeMailbox = { calls, opened, closed: 0, factory: async () => { throw new Error("replaced below"); } };
  let fetched = 0;
  box.factory = async (opts) => {
    if (options.failConnect) throw options.failConnect;
    opened.push({ label: opts.label, user: opts.user, host: opts.host });
    const session: MailSession = {
      async listSince(since) {
        calls.push(`listSince ${since.toISOString()}`);
        const headers: MailHeader[] = messages
          .filter((m) => m.date.getTime() >= since.getTime())
          .map((m) => ({ uid: m.uid, messageId: m.messageId, from: m.from, subject: m.subject, receivedAt: m.date }));
        return headers.sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
      },
      async fetchSource(uid) {
        calls.push(`fetchSource ${uid}`);
        if (options.failFetchAfter !== undefined && fetched >= options.failFetchAfter) {
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        }
        fetched += 1;
        const message = messages.find((m) => m.uid === uid);
        return message ? buildEml(message) : null;
      },
      async close() {
        box.closed += 1;
      },
    };
    return session;
  };
  return box;
}

export function gmailChannels(edit: (block: Record<string, unknown>) => void = () => {}): ChannelsConfig {
  const raw = structuredClone(shippedYaml("sources.yaml")) as { sources: Record<string, Record<string, unknown>> };
  const block = raw.sources.gmail;
  if (!block) throw new Error("no gmail block");
  block.enabled = true;
  edit(block);
  return configRegistry.channels.schema.parse(raw);
}

export interface EmailHarness {
  ctx: ChannelContext;
  query: SearchQuery;
  logs: LogRecord[];
}

export function emailContext(options: { cycleId?: number | null; channels?: ChannelsConfig; signal?: AbortSignal } = {}): EmailHarness {
  const channels = options.channels ?? gmailChannels();
  const logs: LogRecord[] = [];
  const settings = settingsFromConfig("gmail-alerts", channels);
  const ctx = createChannelContext({
    channelId: "gmail-alerts",
    settings,
    http: { timeoutMs: 1000, maxRetries: 0, backoffBaseMs: 1, backoffMaxMs: 1 },
    budget: {
      snapshot: () => ({ month: "2026-10", records: 0, usd: 0, freeRecordsLeft: 0, usdLeft: 0 }),
      canAfford: () => true,
      consume: async () => ({ usd: 0, freeRecords: 0, paidRecords: 0 }),
    },
    signal: options.signal ?? new AbortController().signal,
    cycle: { id: options.cycleId === undefined ? 1 : options.cycleId, kind: "manual" },
    logger: createLogger({ sink: (r) => logs.push(r), minLevel: "debug" }),
    sleep: async () => {},
    random: () => 0,
  });
  const sweep = buildSweepQuery(shippedSearch(), "manual");
  return { ctx, query: { ...sweep, maxResults: Math.min(sweep.maxResults, settings.maxResults) }, logs };
}

export const NOW = new Date("2026-10-07T12:00:00Z");
const hoursAgo = (h: number): Date => new Date(NOW.getTime() - h * 3_600_000);

/** The eight fixture emails as a mailbox: one per fixture, newest first by uid. */
export function fixtureMessages(): FakeMessage[] {
  const names: Array<[string, string, string]> = [
    ["linkedin-digest-en", "jobalerts-noreply@linkedin.com", '"Machine Learning Engineer": Nordwind Robotics GmbH - Berlin and 24 more new jobs'],
    ["linkedin-digest-de", "jobalerts-noreply@linkedin.com", '"Data Scientist": Brandt Analytics GmbH - Hamburg und 8 weitere neue Jobs'],
    ["stepstone-alert-table", "jobs@mail.stepstone.de", "3 neue Jobs für deinen Job-Alert"],
    ["stepstone-alert-div", "jobs@mail.stepstone.de", "2 neue Jobs für dich"],
    ["indeed-alert-en", "alert@indeed.com", "Machine Learning Engineer: 3 new jobs in Berlin"],
    ["indeed-alert-de", "alert@indeed.com", "Data Scientist: 2 neue Jobs in Hamburg"],
    ["xing-alert-1", "no-reply@mail.xing.com", "3 neue Jobs für Ihren Suchauftrag"],
    ["xing-alert-2", "no-reply@mail.xing.com", "2 neue Jobs für Sie"],
  ];
  return names.map(([name, from, subject], index) => ({
    uid: 100 + index,
    from,
    subject,
    messageId: `<${name}@alerts.example.test>`,
    date: hoursAgo(index + 1),
    html: fixtureHtml(name),
  }));
}
