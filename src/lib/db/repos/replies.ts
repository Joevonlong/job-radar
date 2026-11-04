import { and, asc, count, desc, eq, gte, inArray, isNotNull, lt, min, ne, or, sql } from "drizzle-orm";
import { z } from "zod";

import type { RepliesConfig } from "@/lib/config/schemas/replies";
import { nextActionDateToTimestamp } from "@/lib/dashboard/board";
import { needsDecision, suggestFor } from "@/lib/replies/suggest";
import type { ConfirmedThread, MatchCandidate, NextActionKind, ReplyCandidateScore, ReplyCategory, ReplyMatch, ReplyState, ReplySuggestion } from "@/lib/replies/types";

import type { Executor } from "../executor";
import { applicationEvents, applications, companies, emailReplies, jobs, jobSources } from "../schema";
import { revertApplicationStatus, setApplicationNextAction, setApplicationStatus, type ApplicationStatus } from "./applications";

export type EmailReplyRow = typeof emailReplies.$inferSelect;

const CHUNK = 500;

const STATUS = z.enum(["new", "interested", "preparing", "applied", "interviewing", "offer", "rejected", "withdrawn", "archived"]);
const suggestionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("status"), from: STATUS, to: STATUS }),
  z.object({
    kind: z.literal("next_action"),
    from: STATUS,
    action: z.enum(["interview", "send_materials"]),
    due: z.string().nullable(),
    previous: z.object({ nextAction: z.string().nullable(), nextActionAt: z.string().nullable() }).optional(),
    applied: z.object({ nextAction: z.string().nullable(), nextActionAt: z.string().nullable() }).optional(),
  }),
  z.object({ kind: z.literal("mismatch"), from: STATUS }),
  z.object({ kind: z.literal("none") }),
]);
const candidatesSchema = z.array(z.object({ applicationId: z.number(), jobId: z.number(), score: z.number(), hits: z.array(z.string()) }));

/** The stored suggestion; an unreadable one counts as "nothing to do". */
function suggestionOf(json: unknown): ReplySuggestion {
  const parsed = suggestionSchema.safeParse(json);
  return parsed.success ? parsed.data : { kind: "none" };
}

function candidatesOf(json: unknown): ReplyCandidateScore[] {
  const parsed = candidatesSchema.safeParse(json);
  return parsed.success ? parsed.data : [];
}

const effectiveCategory = (row: Pick<EmailReplyRow, "category" | "userCategory">): ReplyCategory => row.userCategory ?? row.category;

// ---------------------------------------------------------------- reading the mailbox

/** Which of `keys` were handled before. */
export async function findKnownReplyKeys(db: Executor, keys: readonly string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let i = 0; i < keys.length; i += CHUNK) {
    const rows = await db.select({ key: emailReplies.dedupeKey }).from(emailReplies).where(inArray(emailReplies.dedupeKey, keys.slice(i, i + CHUNK)));
    for (const row of rows) found.add(row.key);
  }
  return found;
}

export interface ReplyInput {
  dedupeKey: string;
  messageId: string | null;
  threadId: string | null;
  senderDomain: string;
  receivedAt: Date;
  rawRef: string;
  subject: string | null;
  quote: string | null;
  suspiciousInstruction: boolean;
  category: ReplyCategory;
  match: ReplyMatch;
  applicationId: number | null;
  jobId: number | null;
  matchScore: number | null;
  candidates: readonly ReplyCandidateScore[];
  suggestion: ReplySuggestion;
  state: ReplyState;
  decidedAt: Date | null;
}

/** Store one reply; a mail already on record keeps its first outcome. true = stored. */
export async function saveReply(db: Executor, input: ReplyInput): Promise<boolean> {
  const rows = await db
    .insert(emailReplies)
    .values({ ...input, candidates: [...input.candidates] })
    .onConflictDoNothing({ target: emailReplies.dedupeKey })
    .returning({ id: emailReplies.id });
  return rows.length > 0;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The applications a reply may belong to, with what the matching compares. */
export async function listReplyCandidates(db: Executor, statuses: readonly ApplicationStatus[]): Promise<MatchCandidate[]> {
  if (statuses.length === 0) return [];
  const rows = await db
    .select({
      applicationId: applications.id,
      jobId: applications.jobId,
      status: applications.status,
      createdAt: applications.createdAt,
      title: jobs.title,
      companyName: companies.name,
      aliases: companies.aliases,
      atsToken: companies.atsToken,
      websiteDomain: companies.websiteDomain,
    })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(applications.status, [...statuses]));
  if (rows.length === 0) return [];
  const jobIds = rows.map((row) => row.jobId);
  const applicationIds = rows.map((row) => row.applicationId);
  const sources = await db.select({ jobId: jobSources.jobId, url: jobSources.url, applyUrl: jobSources.applyUrl }).from(jobSources).where(inArray(jobSources.jobId, jobIds));
  const firstEvents = await db
    .select({ applicationId: applicationEvents.applicationId, at: min(applicationEvents.at) })
    .from(applicationEvents)
    .where(inArray(applicationEvents.applicationId, applicationIds))
    .groupBy(applicationEvents.applicationId);
  const hosts = new Map<number, Set<string>>();
  for (const source of sources) {
    const set = hosts.get(source.jobId) ?? new Set<string>();
    for (const host of [hostOf(source.url), hostOf(source.applyUrl)]) if (host) set.add(host);
    hosts.set(source.jobId, set);
  }
  const firstAt = new Map(firstEvents.map((event) => [event.applicationId, event.at]));
  return rows.map((row) => {
    const first = firstAt.get(row.applicationId);
    const own = row.websiteDomain ? [row.websiteDomain.toLowerCase()] : [];
    return {
      applicationId: row.applicationId,
      jobId: row.jobId,
      status: row.status,
      companyName: row.companyName,
      aliases: row.aliases,
      atsToken: row.atsToken,
      title: row.title,
      hosts: [...(hosts.get(row.jobId) ?? []), ...own],
      since: first && first.getTime() < row.createdAt.getTime() ? first : row.createdAt,
    };
  });
}

/** The threads of `threadIds` in which the user confirmed a reply. */
export async function listConfirmedThreads(db: Executor, threadIds: readonly string[]): Promise<ConfirmedThread[]> {
  if (threadIds.length === 0) return [];
  const rows = await db
    .select({ threadId: emailReplies.threadId, senderDomain: emailReplies.senderDomain, applicationId: emailReplies.applicationId })
    .from(emailReplies)
    .where(and(inArray(emailReplies.threadId, [...threadIds]), eq(emailReplies.state, "applied"), isNotNull(emailReplies.applicationId)));
  return rows.flatMap((row) => (row.threadId !== null && row.applicationId !== null ? [{ threadId: row.threadId, senderDomain: row.senderDomain, applicationId: row.applicationId }] : []));
}

/** Clear subject and quote of replies decided before `before`; waiting ones keep theirs. How many were cleared. */
export async function pruneDecidedReplies(db: Executor, before: Date): Promise<number> {
  const rows = await db
    .update(emailReplies)
    .set({ subject: null, quote: null })
    .where(and(ne(emailReplies.state, "pending"), sql`coalesce(${emailReplies.decidedAt}, ${emailReplies.createdAt}) < ${before.toISOString()}::timestamptz`, or(isNotNull(emailReplies.subject), isNotNull(emailReplies.quote))))
    .returning({ id: emailReplies.id });
  return rows.length;
}

// ---------------------------------------------------------------- the page

export interface ReplyListRow {
  id: number;
  receivedAt: Date;
  subject: string | null;
  quote: string | null;
  senderDomain: string;
  suspiciousInstruction: boolean;
  category: ReplyCategory;
  match: ReplyMatch;
  state: ReplyState;
  jobId: number | null;
  company: string | null;
  title: string | null;
  status: ApplicationStatus | null;
  candidates: ReplyCandidateScore[];
  suggestion: ReplySuggestion;
}

async function listRows(db: Executor, where: ReturnType<typeof eq>, order: "received" | "decided"): Promise<ReplyListRow[]> {
  const rows = await db
    .select({ reply: emailReplies, company: companies.name, title: jobs.title, status: applications.status })
    .from(emailReplies)
    .leftJoin(applications, eq(applications.id, emailReplies.applicationId))
    .leftJoin(jobs, eq(jobs.id, emailReplies.jobId))
    .leftJoin(companies, eq(companies.id, jobs.companyId))
    .where(where)
    .orderBy(order === "received" ? asc(emailReplies.receivedAt) : desc(emailReplies.decidedAt), asc(emailReplies.id));
  return rows.map(({ reply, company, title, status }) => ({
    id: reply.id,
    receivedAt: reply.receivedAt,
    subject: reply.subject,
    quote: reply.quote,
    senderDomain: reply.senderDomain,
    suspiciousInstruction: reply.suspiciousInstruction,
    category: effectiveCategory(reply),
    match: reply.match,
    state: reply.state,
    jobId: reply.jobId,
    company,
    title,
    status,
    candidates: candidatesOf(reply.candidates),
    suggestion: suggestionOf(reply.suggestion),
  }));
}

/** The replies waiting for the user, oldest mail first. */
export async function listPendingReplies(db: Executor): Promise<ReplyListRow[]> {
  return listRows(db, eq(emailReplies.state, "pending"), "received");
}

/** Replies confirmed since `since`: they keep their Undo. Newest decision first. */
export async function listRecentlyConfirmedReplies(db: Executor, since: Date): Promise<ReplyListRow[]> {
  const where = and(eq(emailReplies.state, "applied"), gte(emailReplies.decidedAt, since));
  return listRows(db, where as ReturnType<typeof eq>, "decided");
}

export async function countPendingReplies(db: Executor): Promise<number> {
  const [row] = await db.select({ n: count() }).from(emailReplies).where(eq(emailReplies.state, "pending"));
  return row?.n ?? 0;
}

/** Waiting replies per job (the mark on the pipeline card). */
export async function countPendingRepliesByJob(db: Executor): Promise<Map<number, number>> {
  const rows = await db
    .select({ jobId: emailReplies.jobId, n: count() })
    .from(emailReplies)
    .where(and(eq(emailReplies.state, "pending"), isNotNull(emailReplies.jobId)))
    .groupBy(emailReplies.jobId);
  return new Map(rows.flatMap((row) => (row.jobId === null ? [] : [[row.jobId, row.n] as const])));
}

export interface ReplyLinkOption {
  jobId: number;
  company: string;
  title: string;
  status: ApplicationStatus;
}

/** What a reply can be linked to by hand: every application in a candidate status. */
export async function listReplyLinkOptions(db: Executor, statuses: readonly ApplicationStatus[]): Promise<ReplyLinkOption[]> {
  if (statuses.length === 0) return [];
  return db
    .select({ jobId: applications.jobId, company: companies.name, title: jobs.title, status: applications.status })
    .from(applications)
    .innerJoin(jobs, eq(jobs.id, applications.jobId))
    .innerJoin(companies, eq(companies.id, jobs.companyId))
    .where(inArray(applications.status, [...statuses]))
    .orderBy(asc(companies.name), asc(jobs.title));
}

/** Replies waiting since before `before` (the doctor's warning). */
export async function countStalePendingReplies(db: Executor, before: Date): Promise<number> {
  const [row] = await db.select({ n: count() }).from(emailReplies).where(and(eq(emailReplies.state, "pending"), lt(emailReplies.createdAt, before)));
  return row?.n ?? 0;
}

// ---------------------------------------------------------------- the user's decisions

export type ReplyDecision =
  /** Carried out; `suggestion` is what was done. */
  | { outcome: "done"; jobId: number | null; suggestion: ReplySuggestion }
  /** The application's status moved on since the suggestion was made: nothing was written, and the suggestion is void. */
  | { outcome: "superseded" }
  /** The reply is gone or no longer in a state that allows this. */
  | { outcome: "stale" };

/** The words that end up on the application, in the user's language. */
export interface ReplyWording {
  /** The note of the timeline event. */
  note(category: ReplyCategory, receivedAt: Date): string;
  /** The text of a suggested next step. */
  nextAction(action: NextActionKind): string;
}

async function lockReply(tx: Executor, id: number): Promise<EmailReplyRow | null> {
  const [row] = await tx.select().from(emailReplies).where(eq(emailReplies.id, id)).for("update").limit(1);
  return row ?? null;
}

/** What is waiting on this application is worked out again from its current status (the reply `exceptId` was just decided). */
async function refreshPendingOf(tx: Executor, applicationId: number, exceptId: number, transitions: RepliesConfig["transitions"], now: Date): Promise<void> {
  const [application] = await tx.select({ status: applications.status }).from(applications).where(eq(applications.id, applicationId)).limit(1);
  if (!application) return;
  const rows = await tx
    .select()
    .from(emailReplies)
    .where(and(eq(emailReplies.applicationId, applicationId), eq(emailReplies.state, "pending"), ne(emailReplies.id, exceptId)));
  for (const row of rows) {
    const category = effectiveCategory(row);
    const suggestion = suggestFor(category, application.status, transitions, row.receivedAt);
    const waits = needsDecision({ category, match: row.match, suggestion });
    await tx.update(emailReplies).set({ suggestion, state: waits ? "pending" : "info", decidedAt: waits ? null : now }).where(eq(emailReplies.id, row.id));
  }
}

/**
 * Carry out a waiting suggestion. The status moves only from the status the suggestion was made for (`allowFrom`), so a change the user made
 * in between wins.
 */
export async function confirmReply(db: Executor, id: number, input: { describe: ReplyWording; transitions: RepliesConfig["transitions"]; now: Date }): Promise<ReplyDecision> {
  return db.transaction(async (tx) => {
    const row = await lockReply(tx, id);
    if (!row || row.state !== "pending" || row.jobId === null || row.applicationId === null) return { outcome: "stale" };
    const suggestion = suggestionOf(row.suggestion);
    const void_ = async (): Promise<ReplyDecision> => {
      await tx.update(emailReplies).set({ state: "superseded", decidedAt: input.now }).where(eq(emailReplies.id, id));
      return { outcome: "superseded" };
    };
    if (suggestion.kind === "status") {
      const change = await setApplicationStatus(tx, row.jobId, suggestion.to, input.describe.note(effectiveCategory(row), row.receivedAt), { allowFrom: [suggestion.from] });
      if (change.rejected || !change.changed) return void_();
      const [event] = await tx
        .select({ id: applicationEvents.id })
        .from(applicationEvents)
        .where(eq(applicationEvents.applicationId, row.applicationId))
        .orderBy(desc(applicationEvents.at), desc(applicationEvents.id))
        .limit(1);
      await tx.update(emailReplies).set({ state: "applied", decidedAt: input.now, eventId: event?.id ?? null }).where(eq(emailReplies.id, id));
      await refreshPendingOf(tx, row.applicationId, id, input.transitions, input.now);
      return { outcome: "done", jobId: row.jobId, suggestion };
    }
    if (suggestion.kind === "next_action") {
      const [application] = await tx.select().from(applications).where(eq(applications.id, row.applicationId)).for("update").limit(1);
      if (!application || application.status !== suggestion.from) return void_();
      await setApplicationNextAction(tx, row.jobId, { nextAction: input.describe.nextAction(suggestion.action), nextActionAt: suggestion.due ? nextActionDateToTimestamp(suggestion.due) : null });
      const [written] = await tx.select({ nextAction: applications.nextAction, nextActionAt: applications.nextActionAt }).from(applications).where(eq(applications.id, row.applicationId)).limit(1);
      const done: ReplySuggestion = {
        ...suggestion,
        previous: { nextAction: application.nextAction, nextActionAt: application.nextActionAt?.toISOString() ?? null },
        applied: { nextAction: written?.nextAction ?? null, nextActionAt: written?.nextActionAt?.toISOString() ?? null },
      };
      await tx.update(emailReplies).set({ state: "applied", decidedAt: input.now, suggestion: done }).where(eq(emailReplies.id, id));
      return { outcome: "done", jobId: row.jobId, suggestion: done };
    }
    return { outcome: "stale" };
  });
}

/** Undo what a confirmation did, unless the application moved on since: then nothing is written and the answer is false (the later change wins). */
async function takeBack(tx: Executor, row: EmailReplyRow): Promise<boolean> {
  if (row.jobId === null) return true;
  const suggestion = suggestionOf(row.suggestion);
  const [application] = await tx.select().from(applications).where(eq(applications.jobId, row.jobId)).for("update").limit(1);
  if (suggestion.kind === "status") {
    if (application?.status !== suggestion.to) return false;
    await revertApplicationStatus(tx, row.jobId, { movedTo: suggestion.to, restoreTo: suggestion.from });
  } else if (suggestion.kind === "next_action") {
    const { previous: before, applied } = suggestion;
    if (!application || (applied && (application.nextAction !== applied.nextAction || (application.nextActionAt?.toISOString() ?? null) !== applied.nextActionAt))) return false;
    await setApplicationNextAction(tx, row.jobId, { nextAction: before?.nextAction ?? null, nextActionAt: before?.nextActionAt ? new Date(before.nextActionAt) : null });
  }
  return true;
}

/** Take a confirmed reply back: a status move leaves no trace (see `revertApplicationStatus`), a next step gets its old value. When the application moved on since, nothing changes on it. */
export async function undoReply(db: Executor, id: number, input: { transitions: RepliesConfig["transitions"]; now: Date }): Promise<ReplyDecision> {
  return db.transaction(async (tx) => {
    const row = await lockReply(tx, id);
    if (!row || row.state !== "applied") return { outcome: "stale" };
    if (!(await takeBack(tx, row))) {
      await tx.update(emailReplies).set({ state: "superseded", decidedAt: input.now }).where(eq(emailReplies.id, id));
      return { outcome: "superseded" };
    }
    await tx.update(emailReplies).set({ state: "reverted", decidedAt: input.now, eventId: null }).where(eq(emailReplies.id, id));
    if (row.applicationId !== null) await refreshPendingOf(tx, row.applicationId, id, input.transitions, input.now);
    return { outcome: "done", jobId: row.jobId, suggestion: suggestionOf(row.suggestion) };
  });
}

export async function dismissReply(db: Executor, id: number, now: Date): Promise<ReplyDecision> {
  const rows = await db
    .update(emailReplies)
    .set({ state: "dismissed", decidedAt: now })
    .where(and(eq(emailReplies.id, id), eq(emailReplies.state, "pending")))
    .returning({ jobId: emailReplies.jobId });
  const [row] = rows;
  return row ? { outcome: "done", jobId: row.jobId, suggestion: { kind: "none" } } : { outcome: "stale" };
}

/** Link a reply to another application and work out its suggestion again; one already carried out is taken back first. false when the job has no application. */
export async function reassignReply(db: Executor, id: number, input: { jobId: number; transitions: RepliesConfig["transitions"]; now: Date }): Promise<ReplyDecision> {
  return db.transaction(async (tx) => {
    const row = await lockReply(tx, id);
    if (!row || (row.state !== "pending" && row.state !== "applied")) return { outcome: "stale" };
    const [target] = await tx.select({ id: applications.id, status: applications.status }).from(applications).where(eq(applications.jobId, input.jobId)).limit(1);
    if (!target) return { outcome: "stale" };
    if (row.state === "applied") await takeBack(tx, row);
    const [application] = await tx.select({ status: applications.status }).from(applications).where(eq(applications.id, target.id)).limit(1);
    const category = effectiveCategory(row);
    const suggestion = suggestFor(category, application?.status ?? target.status, input.transitions, row.receivedAt);
    const waits = needsDecision({ category, match: "matched", suggestion });
    await tx
      .update(emailReplies)
      .set({ match: "matched", applicationId: target.id, jobId: input.jobId, suggestion, state: waits ? "pending" : "info", decidedAt: waits ? null : input.now, eventId: null })
      .where(eq(emailReplies.id, id));
    // what else waits on the old application was worked out for the status it had before
    if (row.applicationId !== null && row.applicationId !== target.id) await refreshPendingOf(tx, row.applicationId, id, input.transitions, input.now);
    return { outcome: "done", jobId: input.jobId, suggestion };
  });
}

/** The user names the category: the suggestion is worked out again, and an `interested` application only keeps an acknowledgement. */
export async function recategorizeReply(db: Executor, id: number, input: { category: ReplyCategory; transitions: RepliesConfig["transitions"]; now: Date }): Promise<ReplyDecision> {
  return db.transaction(async (tx) => {
    const row = await lockReply(tx, id);
    if (!row || row.state !== "pending") return { outcome: "stale" };
    const [application] = row.applicationId === null ? [] : await tx.select({ status: applications.status }).from(applications).where(eq(applications.id, row.applicationId)).limit(1);
    const detach = application?.status === "interested" && input.category !== "acknowledgement";
    const status = detach ? null : (application?.status ?? null);
    const match: ReplyMatch = detach ? "unmatched" : row.match;
    const suggestion = suggestFor(input.category, status, input.transitions, row.receivedAt);
    const waits = needsDecision({ category: input.category, match, suggestion });
    await tx
      .update(emailReplies)
      .set({
        userCategory: input.category,
        match,
        suggestion,
        state: waits ? "pending" : "info",
        decidedAt: waits ? null : input.now,
        ...(detach ? { applicationId: null, jobId: null } : {}),
      })
      .where(eq(emailReplies.id, id));
    return { outcome: "done", jobId: detach ? null : row.jobId, suggestion };
  });
}
