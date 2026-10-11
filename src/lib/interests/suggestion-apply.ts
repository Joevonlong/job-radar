/**
 * Approving and rejecting interest suggestions. Approving is the only place a suggestion changes a config
 * file, and always through `writeConfig` (comments kept, atomic replace, validated, profile snapshot hook for
 * preferences.yaml). Server Actions in `app/interests/suggestion-actions.ts` are thin wrappers around these
 * functions; whatever arrives here is untrusted and checked with zod (C6).
 */
import { z } from "zod";

import { ConfigError, ensureProfileFiles, reloadConfig, writeConfig, type InterestsConfig, type PreferencesConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import { getDb } from "@/lib/db";
import { decideSuggestion, getSuggestion, reopenSuggestion } from "@/lib/db/repos/interest-suggestions";
import { resolveCompanyName } from "@/lib/pipeline/company";
import { registerProfileSnapshotHook } from "@/lib/profile/snapshots";
import { reconcileBonuses } from "@/lib/signals";

import { normalizeTerm, suggestedCategoryId, suggestionPayloadSchema, suggestedValue, type SuggestionPayload } from "./suggestion";
import type { SuggestionActionState, SuggestionRecompute } from "./suggestion-types";

// ---------------------------------------------------------------- the change itself (pure)

export interface ConfigPair {
  interests: InterestsConfig;
  preferences: PreferencesConfig;
}

export interface AppliedSuggestion {
  /** Which files changed; both false when the value was already in its list. */
  interestsChanged: boolean;
  preferencesChanged: boolean;
  interests: InterestsConfig;
  preferences: PreferencesConfig;
}

/** A signal word whose category is no longer active: the approval fails with `categoryMissing`. */
export class SuggestionCategoryMissing extends Error {
  constructor() {
    super("the suggested category is not an active keyword or tag category");
    this.name = "SuggestionCategoryMissing";
  }
}

const includesTerm = (list: readonly string[], value: string): boolean => list.some((item) => normalizeTerm(item) === normalizeTerm(value));

/**
 * `current` with the suggestion applied: a word goes into the keyword list of its tier (or the benefit tags), a company
 * into the watched companies, a filter into the matching list of preferences.yaml. A value that is already in its
 * list changes nothing (the user may have added it by hand since). Pure: returns new objects.
 */
export function applySuggestion(payload: SuggestionPayload, current: ConfigPair, normalizeCompany: (name: string) => string): AppliedSuggestion {
  const interests = structuredClone(current.interests) as InterestsConfig;
  const preferences = structuredClone(current.preferences) as PreferencesConfig;
  const value = suggestedValue(payload).trim();
  const unchanged: AppliedSuggestion = { interestsChanged: false, preferencesChanged: false, interests, preferences };

  switch (payload.kind) {
    case "signal_word": {
      const id = suggestedCategoryId(payload.tier, interests.signals.categories);
      const category = id === null ? undefined : interests.signals.categories.find((c) => c.id === id);
      // the category was deleted (or never existed) since the suggestion was made
      if (!category || category.kind === "amount") throw new SuggestionCategoryMissing();
      const list = category.kind === "keyword" ? category.keywords : category.tags;
      if (includesTerm(list, value)) return unchanged;
      list.push(value);
      return { ...unchanged, interestsChanged: true };
    }
    case "watched_company": {
      const key = normalizeCompany(value);
      if (interests.watched_companies.some((name) => normalizeCompany(name) === key)) return unchanged;
      interests.watched_companies.push(value);
      return { ...unchanged, interestsChanged: true };
    }
    case "filter": {
      if (payload.action === "exclude_keyword") {
        if (includesTerm(preferences.exclude_keywords, value)) return unchanged;
        preferences.exclude_keywords.push(value);
      } else if (payload.action === "add_location") {
        if (includesTerm(preferences.locations, value)) return unchanged;
        preferences.locations.push(value);
      } else {
        const key = normalizeCompany(value);
        if (preferences.exclude_companies.some((name) => normalizeCompany(name) === key)) return unchanged;
        preferences.exclude_companies.push(value);
      }
      return { ...unchanged, preferencesChanged: true };
    }
  }
}

// ---------------------------------------------------------------- plumbing

let queue: Promise<unknown> = Promise.resolve();

/** Config changes of this process run one after another (read, change, write must not interleave). */
function exclusive<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

const idSchema = z.number().int().positive();
const nonce = (): number => Date.now();

const failed = (id: number, error: Extract<SuggestionActionState, { status: "error" }>["error"]): SuggestionActionState => ({ status: "error", id, error, nonce: nonce() });

function normalizer(): (name: string) => string {
  try {
    const pipeline = loadPipeline();
    return (name) => resolveCompanyName(name, pipeline).nameNorm;
  } catch {
    return normalizeTerm;
  }
}

/** Write the changed files. interests.yaml first; if preferences.yaml then fails, the first write stays (it is harmless on its own). */
async function writeChanges(applied: AppliedSuggestion): Promise<void> {
  if (applied.interestsChanged) await writeConfig("interests", applied.interests);
  if (applied.preferencesChanged) {
    registerProfileSnapshotHook();
    await writeConfig("preferences", applied.preferences);
  }
}

/**
 * Bring the ranking in line with a changed interests.yaml right away and without AI (`reconcileBonuses`, a
 * SQL-only pass). New words only start to count once the next cycle's `signals` step has scanned the descriptions
 * again (it does so by itself: the vocabulary fingerprint changed), which `rescanPending` says. A changed
 * preferences.yaml gets a new profile snapshot, which marks the scores stale for the re-scoring.
 */
async function recompute(applied: AppliedSuggestion, payload: SuggestionPayload): Promise<SuggestionRecompute> {
  const rescorePending = applied.preferencesChanged;
  if (!applied.interestsChanged) return { reconciled: false, checked: 0, updated: 0, rescanPending: false, rescorePending };
  const rescanPending = payload.kind === "signal_word";
  try {
    const result = await reconcileBonuses(getDb(), applied.interests);
    return { reconciled: true, checked: result.checked, updated: result.updated, rescanPending, rescorePending };
  } catch {
    return { reconciled: false, checked: 0, updated: 0, rescanPending, rescorePending };
  }
}

// ---------------------------------------------------------------- approve / reject

/**
 * Approve one pending suggestion: claim it (only one click or tab can), write the list it belongs to, then
 * recompute. When the write fails the suggestion goes back to pending, so nothing is lost.
 */
export async function approveSuggestion(rawId: unknown): Promise<SuggestionActionState> {
  const parsedId = idSchema.safeParse(rawId);
  if (!parsedId.success) return failed(0, "invalidPayload");
  const id = parsedId.data;
  const db = getDb();

  let row;
  try {
    row = await getSuggestion(db, id);
  } catch {
    return failed(id, "databaseUnavailable");
  }
  if (!row) return failed(id, "notFound");
  if (row.status !== "pending") return failed(id, "alreadyDecided");
  const payload = suggestionPayloadSchema.safeParse(row.payloadJson);
  if (!payload.success) return failed(id, "unreadableSuggestion");

  const claimed = await decideSuggestion(db, id, "approved").catch(() => undefined);
  if (claimed === undefined) return failed(id, "databaseUnavailable");
  if (claimed === null) return failed(id, "alreadyDecided");

  const outcome = await exclusive(async (): Promise<AppliedSuggestion | "unreadable" | "writeFailed" | "categoryMissing"> => {
    try {
      await ensureProfileFiles();
      const current = { interests: reloadConfig("interests"), preferences: reloadConfig("preferences") };
      const applied = applySuggestion(payload.data, current, normalizer());
      await writeChanges(applied);
      return applied;
    } catch (error) {
      if (error instanceof SuggestionCategoryMissing) return "categoryMissing";
      return error instanceof ConfigError && error.kind !== "schema" ? "unreadable" : "writeFailed";
    }
  });
  if (typeof outcome === "string") {
    await reopenSuggestion(db, id).catch(() => undefined);
    return failed(id, outcome);
  }
  const changed = outcome.interestsChanged || outcome.preferencesChanged;
  return { status: "approved", id, nonce: nonce(), change: changed ? "added" : "alreadyPresent", recompute: await recompute(outcome, payload.data) };
}

/** Reject one pending suggestion; its key stays, so it is never proposed again. */
export async function rejectSuggestion(rawId: unknown): Promise<SuggestionActionState> {
  const parsedId = idSchema.safeParse(rawId);
  if (!parsedId.success) return failed(0, "invalidPayload");
  const id = parsedId.data;
  try {
    const row = await getSuggestion(getDb(), id);
    if (!row) return failed(id, "notFound");
    if ((await decideSuggestion(getDb(), id, "rejected")) === null) return failed(id, "alreadyDecided");
    return { status: "rejected", id, nonce: nonce() };
  } catch {
    return failed(id, "databaseUnavailable");
  }
}
