import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { getConfigDir, getProfileDir } from "@/lib/config/paths";
import type { Db } from "@/lib/db/client";
import { withCycleLock } from "@/lib/db/cycle-lock";
import type { Executor } from "@/lib/db/executor";
import { getCompanyById, listCompaniesForDuplicateCheck } from "@/lib/db/repos/companies";
import {
  applyCompanyMerge,
  CompanyMergeRefused,
  findCompanyMerge,
  listCompanyMerges,
  listRunningCompanyAiRequests,
  planCompanyMerge,
  planCompanyUndo,
  undoCompanyMerge,
  type CompanyMergeContext,
  type CompanyMergeNote,
  type CompanyMergePlan,
  type CompanyMergeRefusal,
  type CompanyUndoPlan,
  type CompanyUndoRefusal,
} from "@/lib/db/repos/company-merges";
import type { translatorFor } from "@/lib/i18n/node";

import { suggestCompanyMerges } from "./merge-suggest";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export interface CompanyMergePair {
  fromId: number;
  intoId: number;
}

const companyId = z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
const pairSchema = z.tuple([companyId, companyId]).transform(([fromId, intoId]): CompanyMergePair => ({ fromId, intoId }));

export type ParsedPlan = { ok: true; pairs: CompanyMergePair[] } | { ok: false; line: number; text: string };

/** A plan file: one `FROM_ID INTO_ID` per line, `#` starts a comment, blank lines are ignored. */
export function parsePlanText(text: string): ParsedPlan {
  const pairs: CompanyMergePair[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = (raw.split("#")[0] ?? "").trim();
    if (line === "") continue;
    const parsed = pairSchema.safeParse(line.split(/\s+/));
    if (!parsed.success) return { ok: false, line: index + 1, text: line };
    pairs.push(parsed.data);
  }
  return { ok: true, pairs };
}

export interface CompanyMergeRunInput {
  db: Db;
  argv: readonly string[];
  context: () => CompanyMergeContext;
  t: ReturnType<typeof translatorFor<"cli.companiesMerge">>;
  out: (line: string) => void;
  err: (line: string) => void;
}

/** Text that came from a posting or a config file, on one line of a terminal or a plan file. */
const oneLine = (text: string): string => text.replace(/[\p{C}\s]+/gu, " ").trim();

/** What went wrong, not the failed query and its parameters that a database error's own message spells out. */
export function failureText(error: unknown): string {
  const root = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  if (!(root instanceof Error)) return oneLine(String(root));
  return oneLine(root.message) || root.name;
}

/** The real path of a directory that may not exist yet. */
function realDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Those two directories are written only under the config write lock, and a plan file is no config. */
function isInUserDirectories(file: string): boolean {
  const target = path.join(realDir(path.dirname(path.resolve(file))), path.basename(file));
  return [getConfigDir(), getProfileDir()].some((dir) => {
    const relative = path.relative(realDir(dir), target);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  });
}

/** Everything without `--apply` runs in a read-only transaction: Postgres itself refuses a write. */
const readOnly = <T>(db: Db, fn: (tx: Executor) => Promise<T>): Promise<T> => db.transaction(fn, { accessMode: "read only" });

function printPlan(input: CompanyMergeRunInput, plan: CompanyMergePlan): void {
  const { t, out } = input;
  out(t("pairJobs", { jobs: plan.jobs, open: plan.openJobs, acted: plan.actedJobs, sameTitle: plan.sameTitleJobs }));
  out(t("pairCaches", { salary: plan.salaryLookups, research: plan.research, aliases: plan.newAliases.length === 0 ? "-" : oneLine(plan.newAliases.join(", ")) }));
  out(t("pairMarks", { fromWatched: String(plan.from.watched), fromBlacklisted: String(plan.from.blacklisted), intoWatched: String(plan.into.watched), intoBlacklisted: String(plan.into.blacklisted) }));
  for (const note of plan.notes) out(noteText(input, note));
}

function noteText({ t }: CompanyMergeRunInput, note: CompanyMergeNote): string {
  switch (note.kind) {
    case "website_domain_lost":
      return t("noteDomain", { domain: oneLine(note.domain) });
    case "excluded_entry_spreads":
      return t("noteExcluded");
    case "trusted_entry_stops_matching":
      return t("noteTrusted");
    case "watch_entries_to_edit":
      return t("noteWatch", { entries: oneLine(note.entries.join(", ")) });
  }
}

function mergeRefusalText({ t }: CompanyMergeRunInput, refusal: CompanyMergeRefusal): string {
  switch (refusal) {
    case "same_company":
      return t("refusedSame");
    case "from_missing":
      return t("refusedFromMissing");
    case "into_missing":
      return t("refusedIntoMissing");
    case "watched_and_blacklisted":
      return t("refusedMarks");
  }
}

function undoRefusalText({ t }: CompanyMergeRunInput, refusal: Exclude<CompanyUndoRefusal, "merge_missing">): string {
  switch (refusal) {
    case "already_undone":
      return t("undoAlready");
    case "from_key_taken":
      return t("undoKeyTaken");
    case "into_missing":
      return t("undoIntoMissing");
    case "later_merge":
      return t("undoLater");
  }
}

interface PlanState {
  /** Rows earlier pairs of this plan remove, with the row they go into. */
  removed: Map<number, number>;
  /** Rows earlier pairs of this plan merge into. */
  grown: Set<number>;
}

type PairState = { kind: "done"; mergeId: number | null } | { kind: "refused"; line: string } | { kind: "ready"; plan: CompanyMergePlan; chained: boolean };

/** How a pair stands before it is merged; a dry run and `--apply` share it, so they refuse the same pairs. */
async function pairState(db: Executor, input: CompanyMergeRunInput, pair: CompanyMergePair, state: PlanState, context: CompanyMergeContext): Promise<PairState> {
  const { t } = input;
  const { fromId, intoId } = pair;
  if (fromId !== intoId) {
    const mergeId = await findCompanyMerge(db, fromId, intoId);
    if (state.removed.get(fromId) === intoId || (mergeId !== null && (await getCompanyById(db, fromId)) === null)) return { kind: "done", mergeId };
  }
  if (state.removed.has(fromId)) return { kind: "refused", line: t("refusedFromMissing") };
  if (state.removed.has(intoId)) return { kind: "refused", line: t("refusedIntoRemoved") };
  const plan = await planCompanyMerge(db, fromId, intoId, context);
  if (!("from" in plan)) return { kind: "refused", line: mergeRefusalText(input, plan.refusal) };
  if (plan.refusal !== null) return { kind: "refused", line: mergeRefusalText(input, plan.refusal) };
  return { kind: "ready", plan, chained: state.grown.has(fromId) };
}

function pairTitle({ t }: CompanyMergeRunInput, pair: CompanyMergePair, plan?: CompanyMergePlan): string {
  return plan ? t("pairTitle", { fromName: oneLine(plan.from.name), fromId: pair.fromId, intoName: oneLine(plan.into.name), intoId: pair.intoId }) : t("pairPlain", { fromId: pair.fromId, intoId: pair.intoId });
}

async function dryRunPairs(input: CompanyMergeRunInput, pairs: readonly CompanyMergePair[]): Promise<number> {
  const { db, out, t } = input;
  const context = input.context();
  const tally = await readOnly(db, async (tx) => {
    const counts = { ok: 0, done: 0, failed: 0 };
    const state: PlanState = { removed: new Map(), grown: new Set() };
    for (const pair of pairs) {
      const current = await pairState(tx, input, pair, state, context);
      if (current.kind === "ready") {
        out(pairTitle(input, pair, current.plan));
        printPlan(input, current.plan);
        if (current.chained) out(t("noteChained"));
        state.removed.set(pair.fromId, pair.intoId);
        state.grown.add(pair.intoId);
        counts.ok += 1;
      } else if (current.kind === "done") {
        out(pairTitle(input, pair));
        out(current.mergeId === null ? t("already", { mergeId: "-" }) : t("already", { mergeId: current.mergeId }));
        counts.done += 1;
      } else {
        out(pairTitle(input, pair));
        out(current.line);
        counts.failed += 1;
      }
    }
    return counts;
  });
  out(t("summaryDry", tally));
  return tally.failed > 0 ? EXIT_FAILED : EXIT_OK;
}

/** The lock, then the check for running AI requests; `fn` only runs when both allow it. */
async function underCycleLock(input: CompanyMergeRunInput, fn: (signal: AbortSignal) => Promise<number>): Promise<number> {
  const { db, err, t } = input;
  const locked = await withCycleLock(db, "try", async ({ signal }) => {
    const running = await listRunningCompanyAiRequests(db);
    if (running.length > 0) {
      err(t("aiRunning", { ids: running.join(", ") }));
      return EXIT_FAILED;
    }
    return fn(signal);
  });
  if (locked.acquired) return locked.value;
  err(t("lockBusy"));
  return EXIT_FAILED;
}

async function applyPairs(input: CompanyMergeRunInput, pairs: readonly CompanyMergePair[]): Promise<number> {
  const { db, out, err, t } = input;
  const context = input.context();
  return underCycleLock(input, async (signal) => {
    const counts = { ok: 0, done: 0, failed: 0 };
    const state: PlanState = { removed: new Map(), grown: new Set() };
    for (const [index, pair] of pairs.entries()) {
      if (signal.aborted) {
        err(t("lockLost", { count: pairs.length - index }));
        counts.failed += pairs.length - index;
        break;
      }
      const current = await pairState(db, input, pair, state, context);
      if (current.kind === "done") {
        out(pairTitle(input, pair));
        out(current.mergeId === null ? t("already", { mergeId: "-" }) : t("already", { mergeId: current.mergeId }));
        counts.done += 1;
        continue;
      }
      if (current.kind === "refused") {
        out(pairTitle(input, pair));
        out(current.line);
        counts.failed += 1;
        continue;
      }
      out(pairTitle(input, pair, current.plan));
      try {
        const applied = await db.transaction((tx) => applyCompanyMerge(tx, pair.fromId, pair.intoId, context));
        printPlan(input, applied.plan);
        out(t("merged", { mergeId: applied.mergeId }));
        state.removed.set(pair.fromId, pair.intoId);
        state.grown.add(pair.intoId);
        counts.ok += 1;
      } catch (error) {
        if (error instanceof CompanyMergeRefused && isMergeRefusal(error.refusal)) out(mergeRefusalText(input, error.refusal));
        else out(t("pairFailed", { error: failureText(error) }));
        counts.failed += 1;
      }
    }
    out(t("summaryApply", counts));
    return counts.failed > 0 ? EXIT_FAILED : EXIT_OK;
  });
}

const isMergeRefusal = (refusal: CompanyMergeRefusal | CompanyUndoRefusal): refusal is CompanyMergeRefusal =>
  refusal === "same_company" || refusal === "from_missing" || refusal === "into_missing" || refusal === "watched_and_blacklisted";

function printUndoPlan(input: CompanyMergeRunInput, plan: CompanyUndoPlan): void {
  const { t, out } = input;
  out(t("undoTitle", { mergeId: plan.mergeId, fromName: oneLine(plan.fromName), fromId: plan.fromId, intoName: plan.intoName === null ? t("unknownCompany") : oneLine(plan.intoName), intoId: plan.intoId }));
  out(t("undoMoves", { jobs: plan.jobs, salary: plan.salaryLookups, research: plan.research }));
  out(t("undoArrived", { jobs: plan.arrivedJobs, sources: plan.arrivedSources }));
  out(t("undoStays", { salary: plan.newSalaryLookups, research: plan.newResearch }));
}

async function runUndo(input: CompanyMergeRunInput, mergeId: number, apply: boolean): Promise<number> {
  const { db, out, t } = input;
  const plan = await readOnly(db, (tx) => planCompanyUndo(tx, mergeId));
  if (!("mergeId" in plan)) {
    out(t("undoMissing", { mergeId }));
    return EXIT_FAILED;
  }
  printUndoPlan(input, plan);
  if (!apply || plan.refusal !== null) {
    if (plan.refusal !== null) out(undoRefusalText(input, plan.refusal));
    else out(t("undoDry"));
    return plan.refusal !== null ? EXIT_FAILED : EXIT_OK;
  }
  return underCycleLock(input, async () => {
    try {
      const { keptFields } = await db.transaction((tx) => undoCompanyMerge(tx, mergeId));
      if (keptFields.length > 0) out(t("undoKept", { fields: keptFields.join(", ") }));
      out(t("undoDone"));
      return EXIT_OK;
    } catch (error) {
      if (error instanceof CompanyMergeRefused && error.refusal !== "merge_missing" && !isMergeRefusal(error.refusal)) out(undoRefusalText(input, error.refusal));
      else out(t("pairFailed", { error: failureText(error) }));
      return EXIT_FAILED;
    }
  });
}

async function runSuggest(input: CompanyMergeRunInput, tier: 1 | 2 | null, outFile: string | undefined): Promise<number> {
  const { db, t } = input;
  if (outFile !== undefined && isInUserDirectories(outFile)) {
    input.err(t("outInUserDirectory", { file: outFile }));
    return EXIT_USAGE;
  }
  // A file holds the plan alone: redirecting stdout also catches what the package manager prints around the command.
  const lines: string[] = [];
  const out = outFile === undefined ? input.out : (line: string) => void lines.push(line);
  const rows = await readOnly(db, (tx) => listCompaniesForDuplicateCheck(tx));
  const suggestions = suggestCompanyMerges(rows, input.context().pipeline).filter((suggestion) => tier === null || suggestion.tier === tier);
  if (suggestions.length === 0) out(t("suggestNone"));
  for (const { tier: groupTier, into, from } of suggestions) {
    out(t("suggestGroup", { tier: groupTier, name: oneLine(into.name), jobs: into.jobCount }));
    for (const row of from) out(t("suggestLine", { fromId: row.id, intoId: into.id, fromName: oneLine(row.name), fromJobs: row.jobCount, intoName: oneLine(into.name), intoJobs: into.jobCount }));
  }
  if (outFile !== undefined) {
    try {
      writeFileSync(outFile, `${lines.join("\n")}\n`);
    } catch {
      input.err(t("outUnwritable", { file: outFile }));
      return EXIT_USAGE;
    }
    input.out(t("suggestWritten", { count: suggestions.reduce((sum, suggestion) => sum + suggestion.from.length, 0), file: outFile }));
  }
  return EXIT_OK;
}

async function runList({ db, out, t }: CompanyMergeRunInput): Promise<number> {
  const merges = await readOnly(db, (tx) => listCompanyMerges(tx));
  if (merges.length === 0) out(t("listNone"));
  for (const merge of merges) {
    out(
      t("listRow", {
        id: merge.id,
        mergedAt: merge.mergedAt.toISOString(),
        fromName: oneLine(merge.fromName),
        fromId: merge.fromId,
        intoName: merge.intoName === null ? t("unknownCompany") : oneLine(merge.intoName),
        intoId: merge.intoId,
        jobs: merge.jobs,
        undone: merge.undoneAt === null ? t("listActive") : t("listUndone", { at: merge.undoneAt.toISOString() }),
      }),
    );
  }
  return EXIT_OK;
}

/** `pnpm companies:merge`: returns the exit code (0 all well, 1 a pair failed or was refused or the lock is taken, 2 bad arguments or plan). */
export async function runCompaniesMerge(input: CompanyMergeRunInput): Promise<number> {
  const { err, t } = input;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...input.argv],
      strict: true,
      options: {
        suggest: { type: "boolean" },
        tier: { type: "string" },
        out: { type: "string" },
        pair: { type: "string", multiple: true },
        plan: { type: "string" },
        apply: { type: "boolean" },
        undo: { type: "string" },
        list: { type: "boolean" },
      },
    }));
  } catch {
    err(t("usage"));
    return EXIT_USAGE;
  }
  const { suggest = false, tier, out: outFile, pair: pairArgs, plan: planFile, apply = false, undo, list = false } = values;
  const modes = [suggest, pairArgs !== undefined, planFile !== undefined, undo !== undefined, list].filter(Boolean).length;
  const applies = pairArgs !== undefined || planFile !== undefined || undo !== undefined;
  if (modes !== 1 || (apply && !applies) || (tier !== undefined && (!suggest || (tier !== "1" && tier !== "2"))) || (outFile !== undefined && (!suggest || outFile === ""))) {
    err(t("usage"));
    return EXIT_USAGE;
  }

  if (suggest) return runSuggest(input, tier === undefined ? null : tier === "1" ? 1 : 2, outFile);
  if (list) return runList(input);
  if (undo !== undefined) {
    const mergeId = companyId.safeParse(undo);
    if (!mergeId.success) {
      err(t("usage"));
      return EXIT_USAGE;
    }
    return runUndo(input, mergeId.data, apply);
  }

  let pairs: CompanyMergePair[] = [];
  if (planFile !== undefined) {
    let text: string;
    try {
      text = readFileSync(planFile, "utf8");
    } catch {
      err(t("planUnreadable", { file: planFile }));
      return EXIT_USAGE;
    }
    const parsed = parsePlanText(text);
    if (!parsed.ok) {
      err(t("planBadLine", { line: parsed.line, text: oneLine(parsed.text) }));
      return EXIT_USAGE;
    }
    pairs = parsed.pairs;
  } else {
    for (const arg of pairArgs ?? []) {
      const parsed = pairSchema.safeParse(arg.split(":"));
      if (!parsed.success) {
        err(t("badPair", { pair: oneLine(arg) }));
        return EXIT_USAGE;
      }
      pairs.push(parsed.data);
    }
  }
  if (pairs.length === 0) {
    input.out(t("nothingToDo"));
    return EXIT_OK;
  }
  return apply ? applyPairs(input, pairs) : dryRunPairs(input, pairs);
}
