import { XMLParser } from "fast-xml-parser";
import { z } from "zod";

import { ChannelError } from "@/lib/channels/errors";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { personioChannelSchema } from "@/lib/config";

import type { AtsAdapter, ListedPosting } from "./collect";
import { fetchBoard } from "./conditional";
import { htmlFragments, issuePaths, readEnvelopePosting, unwrapPayload } from "./envelope";
import { htmlToText } from "./text";

/**
 * Personio career-site feed (`GET https://{company}.jobs.personio.de/xml?language=en`): one XML
 * document (`<workzag-jobs>`) with every open position, descriptions included, ETag-capable. The
 * feed has no salary and no job URL: the URL is `<site>/job/{id}`.
 */

const xmlParser = new XMLParser({
  // ids and counts stay text; the XML has no typed values
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (_name, jPath) =>
    jPath === "workzag-jobs.position" ||
    jPath === "workzag-jobs.position.additionalOffices.office" ||
    jPath === "workzag-jobs.position.jobDescriptions.jobDescription",
});

/** What `fetchBoard` hands to `list`: the career site and the positions of the feed. */
interface PersonioBoard {
  site: string;
  positions: unknown[];
}

function decodeFeed(site: string): (text: string) => PersonioBoard {
  return (text) => {
    const document: unknown = xmlParser.parse(text);
    const root = typeof document === "object" && document !== null ? (document as Record<string, unknown>)["workzag-jobs"] : undefined;
    if (root === undefined) throw new Error("not a Personio feed (no workzag-jobs element)");
    // an empty feed parses to an empty string
    const positions = typeof root === "object" && root !== null ? (root as { position?: unknown[] }).position : undefined;
    return { site, positions: positions ?? [] };
  };
}

const text = z.string().nullable().optional();
/** An element without children (`<jobDescriptions></jobDescriptions>`) parses to "". */
const listOf = <T extends z.ZodType>(key: string, item: T) =>
  z.union([z.string(), z.looseObject({ [key]: z.array(item).optional() })]).nullable().optional();

const positionSchema = z.looseObject({
  id: z.string().trim().min(1),
  name: z.string().trim().min(1),
  jobUrl: z.string().nullable().optional(),
  subcompany: text,
  office: text,
  additionalOffices: listOf("office", z.string()),
  department: text,
  recruitingCategory: text,
  jobDescriptions: listOf("jobDescription", z.looseObject({ name: text, value: text })),
  employmentType: text,
  seniority: text,
  schedule: text,
  yearsOfExperience: text,
  keywords: text,
  occupation: text,
  occupationCategory: text,
  createdAt: text,
});
type PersonioPosition = z.infer<typeof positionSchema>;

const httpUrl = z.url({ protocol: /^https?$/ });

function urlOrNull(value: string | null | undefined): string | null {
  const parsed = httpUrl.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function dateOrNull(value: string | null | undefined): Date | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time);
}

function childrenOf<K extends string, T>(value: string | null | undefined | Record<string, unknown>, key: K): T[] {
  if (typeof value !== "object" || value === null) return [];
  const items = value[key];
  return Array.isArray(items) ? (items as T[]) : [];
}

function locationLabels(position: PersonioPosition): string[] {
  const labels = [position.office?.trim() ?? "", ...childrenOf<"office", string>(position.additionalOffices, "office").map((o) => o.trim())];
  return [...new Set(labels.filter((l) => l !== ""))];
}

/** Only a clear "remote" or "hybrid" label counts; "Remote / Hybrid" (both) and plain city names say nothing (C3). */
function workplaceOf(labels: readonly string[]): NormalizedPostingDraft["workplace"] {
  const joined = labels.join(" ");
  const remote = /remote/i.test(joined);
  const hybrid = /hybrid/i.test(joined);
  if (remote && !hybrid) return "remote";
  if (hybrid && !remote) return "hybrid";
  return "unknown";
}

function descriptionOf(position: PersonioPosition): string {
  const sections = childrenOf<"jobDescription", { name?: string | null; value?: string | null }>(position.jobDescriptions, "jobDescription");
  return sections
    .map((section) => {
      const heading = section.name?.trim() ?? "";
      const body = htmlToText(section.value ?? "");
      return [heading, body].filter((p) => p !== "").join("\n");
    })
    .filter((block) => block !== "")
    .join("\n\n");
}

function describe(posting: unknown): ListedPosting | null {
  if (typeof posting !== "object" || posting === null) return null;
  const record = posting as Record<string, unknown>;
  const externalId = typeof record.id === "string" ? record.id.trim() : "";
  if (externalId === "") return null;
  return {
    externalId,
    title: typeof record.name === "string" ? record.name : null,
    url: typeof record.jobUrl === "string" ? record.jobUrl : null,
    postedAt: dateOrNull(typeof record.createdAt === "string" ? record.createdAt : null),
  };
}

function siteOf(token: string, template: string): string {
  return template.replace("{token}", encodeURIComponent(token)).replace(/\/+$/, "");
}

function boardUrlOf(company: { token: string }, settings: z.infer<typeof personioChannelSchema>): string {
  return `${siteOf(company.token, settings.api_base_url)}/xml?language=${settings.language}`;
}

export const personioAdapter: AtsAdapter<z.infer<typeof personioChannelSchema>> = {
  id: "personio",
  settingsSchema: personioChannelSchema,
  boardUrl: boardUrlOf,
  fetchBoard(ctx, company, settings, etag) {
    const site = siteOf(company.token, settings.api_base_url);
    return fetchBoard(ctx, boardUrlOf(company, settings), etag, { accept: "application/xml", decode: decodeFeed(site) });
  },
  list(body) {
    const board = body as Partial<PersonioBoard> | null;
    if (typeof board !== "object" || board === null || typeof board.site !== "string" || !Array.isArray(board.positions)) {
      throw new ChannelError("parse", "personio board response does not match the expected shape");
    }
    const { site, positions } = board;
    // the feed has no URL of its own: record where the career page of each position is
    return positions.map((position) =>
      typeof position === "object" && position !== null && typeof (position as { id?: unknown }).id === "string"
        ? { ...position, jobUrl: `${site}/job/${encodeURIComponent((position as { id: string }).id)}` }
        : position,
    );
  },
  describe,
  parse(payload) {
    const { source, posting } = unwrapPayload(payload, "personio");
    const parsed = positionSchema.safeParse(posting);
    if (!parsed.success) {
      throw new ChannelError("parse", `personio posting does not match the expected shape (${issuePaths(parsed.error)})`);
    }
    return toDraft(parsed.data, source.companyName);
  },
  descriptionHtml(payload) {
    const position = readEnvelopePosting(payload, "personio", positionSchema);
    if (!position) return [];
    const sections = childrenOf<"jobDescription", { name?: string | null; value?: string | null }>(position.jobDescriptions, "jobDescription");
    return htmlFragments(sections.map((section, index) => ({ path: `posting.jobDescriptions.jobDescription[${index}].value`, html: section.value })));
  },
};

function toDraft(position: PersonioPosition, companyName: string): NormalizedPostingDraft {
  const labels = locationLabels(position);
  const url = urlOrNull(position.jobUrl);
  const contract = [position.employmentType, position.schedule].map((p) => p?.trim() ?? "").filter((p) => p !== "");
  return {
    title: position.name,
    companyName,
    locations: labels.map((label) => ({ label, city: null, countryCode: null })),
    workplace: workplaceOf(labels),
    contractHint: contract.length > 0 ? contract.join(", ") : null,
    seniorityHint: position.seniority?.trim() || null,
    salaryText: null,
    salary: null,
    description: descriptionOf(position),
    postedAt: dateOrNull(position.createdAt),
    applyUrl: url,
    sourceUrl: url,
    extra: {
      ats: "personio",
      subcompany: position.subcompany ?? null,
      department: position.department ?? null,
      recruitingCategory: position.recruitingCategory ?? null,
      keywords: (position.keywords ?? "").split(",").map((k) => k.trim()).filter((k) => k !== ""),
      yearsOfExperience: position.yearsOfExperience ?? null,
      occupationCategory: position.occupationCategory ?? null,
    },
  };
}
