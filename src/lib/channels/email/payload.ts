import { createHash } from "node:crypto";

import { z } from "zod";

import { gmailPlatformSchema } from "./platform";
import { ChannelError } from "../errors";
import type { NormalizedPostingDraft } from "../types";
import type { AlertJob, GmailPlatform } from "./types";

/**
 * What the Gmail channel stores in `raw_postings.payload_json` (C1). The job payload holds only what
 * the card states, so the same job in a later digest produces the same payload (no re-parse); which
 * email it came from is in `email_messages`.
 */
const jobPayloadSchema = z.object({
  kind: z.literal("email_job"),
  platform: gmailPlatformSchema,
  job: z.object({
    id: z.string().nullable(),
    url: z.string(),
    title: z.string(),
    company: z.string().nullable(),
    location: z.string().nullable(),
    workplace: z.enum(["remote", "hybrid", "onsite"]).nullable(),
    salaryText: z.string().nullable(),
    snippet: z.string().nullable(),
  }),
});

/** An email no parser could read: the original goes in whole so the parser can be fixed and re-run (C1). */
const unparsedPayloadSchema = z.object({
  kind: z.literal("email_unparsed"),
  platform: gmailPlatformSchema,
  messageId: z.string(),
  sender: z.string(),
  subject: z.string(),
  receivedAt: z.string(),
  reason: z.string(),
  html: z.string().nullable(),
  text: z.string().nullable(),
});

const payloadSchema = z.discriminatedUnion("kind", [jobPayloadSchema, unparsedPayloadSchema]);
export type EmailJobPayload = z.infer<typeof jobPayloadSchema>;
export type EmailUnparsedPayload = z.infer<typeof unparsedPayloadSchema>;

export function jobPayload(platform: GmailPlatform, job: AlertJob): EmailJobPayload {
  return {
    kind: "email_job",
    platform,
    job: {
      id: job.id,
      url: job.url,
      title: job.title,
      company: job.company,
      location: job.location,
      workplace: job.workplace,
      salaryText: job.salaryText,
      snippet: job.snippet,
    },
  };
}

/** `raw_postings.external_id` of a job: platform id, or the canonical link when the card has no id. */
export function jobExternalId(platform: GmailPlatform, job: AlertJob): string {
  return `${platform}:${job.id ?? job.url}`;
}

export function unparsedExternalId(messageId: string): string {
  return `unparsed:${createHash("sha256").update(messageId).digest("hex").slice(0, 24)}`;
}

function httpUrlOrNull(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** Payload → normalized draft. Throws `ChannelError("parse")` for unparsed emails and incomplete cards. */
export function parseEmailPayload(payload: unknown): NormalizedPostingDraft {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) throw new ChannelError("parse", "email payload does not match the expected shape");
  const value = parsed.data;
  if (value.kind === "email_unparsed") throw new ChannelError("parse", `email could not be parsed: ${value.reason}`);

  const { job, platform } = value;
  const title = job.title.trim();
  if (!title) throw new ChannelError("parse", `${platform} alert card has no title`);
  const company = job.company?.trim();
  // C3: the company is never guessed from the platform name
  if (!company) throw new ChannelError("parse", `${platform} alert card for "${title}" has no company`);
  const url = httpUrlOrNull(job.url);
  return {
    title,
    companyName: company,
    locations: job.location ? [{ label: job.location, city: null, countryCode: null }] : [],
    workplace: job.workplace ?? "unknown",
    salaryText: job.salaryText,
    description: job.snippet ?? "",
    applyUrl: url,
    sourceUrl: url,
    extra: { platform, platformJobId: job.id },
  };
}
