/** What /interests shows of the suggestions: the pending ones, a short history and how the last run went. */
import { z } from "zod";

import { loadConfig } from "@/lib/config";
import { buildCatalog } from "@/lib/signals/catalog";

import { getDb } from "@/lib/db";
import { findLatestControlRequest } from "@/lib/db/repos/control-requests";
import { listSuggestions, type InterestSuggestion } from "@/lib/db/repos/interest-suggestions";

import { suggestedCategoryId, suggestionPayloadSchema, type SuggestionPayload } from "./suggestion";

/** Decided suggestions listed under the pending ones. */
export const HISTORY_LIMIT = 10;
/** Pending suggestions listed at most (a run stores `suggest.max_suggestions` at most, so this is only a guard). */
const PENDING_LIMIT = 100;

export interface SuggestionItemView {
  id: number;
  status: "pending" | "approved" | "rejected";
  createdAt: string;
  decidedAt: string | null;
  /** null: the stored payload does not fit the schema (shown as unreadable, it can still be rejected). */
  payload: SuggestionPayload | null;
  /** A signal word: the name of its category in the page language (the id when it is not in interests.yaml any more). */
  categoryName?: string;
}

export interface SuggestRunView {
  requestedAt: string;
  status: "pending" | "running" | "done" | "failed";
  /** New suggestions the run stored; null while it has not finished. */
  stored: number | null;
  /** Why a finished run asked nothing (`too_few_liked_jobs`). */
  skipped: string | null;
  /** Failure code of a failed run. */
  error: string | null;
}

export interface SuggestionsSectionData {
  pending: SuggestionItemView[];
  decided: SuggestionItemView[];
  lastRun: SuggestRunView | null;
  /** The database could not be read. */
  loadError: boolean;
}

const resultSchema = z.object({ stored: z.number().int().optional(), skipped: z.string().optional(), error: z.string().optional() }).passthrough();

type CategoryNamer = (tier: string) => string;

/** Names of the signal categories in `locale`; the raw id when interests.yaml cannot be read. */
function categoryNamer(locale: string): CategoryNamer {
  try {
    const interests = loadConfig("interests");
    const catalog = buildCatalog(interests);
    const all = [...interests.signals.categories, ...interests.signals.retired_categories];
    return (tier) => {
      const id = suggestedCategoryId(tier, all) ?? tier;
      return catalog.labelOf(id, locale);
    };
  } catch {
    return (tier) => tier;
  }
}

function toView(row: InterestSuggestion, nameOf: CategoryNamer): SuggestionItemView {
  const payload = suggestionPayloadSchema.safeParse(row.payloadJson);
  return {
    id: row.id,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    payload: payload.success ? payload.data : null,
    ...(payload.success && payload.data.kind === "signal_word" ? { categoryName: nameOf(payload.data.tier) } : {}),
  };
}

/** `locale` names the signal categories of word suggestions. */
export async function loadSuggestionsSection(locale = "en"): Promise<SuggestionsSectionData> {
  try {
    const db = getDb();
    const [pending, decided, request] = await Promise.all([
      listSuggestions(db, { status: "pending", limit: PENDING_LIMIT }),
      listSuggestions(db, { status: ["approved", "rejected"], limit: HISTORY_LIMIT }),
      findLatestControlRequest(db, "run_suggest"),
    ]);
    const result = resultSchema.safeParse(request?.result ?? {});
    const nameOf = categoryNamer(locale);
    const view = (row: InterestSuggestion): SuggestionItemView => toView(row, nameOf);
    return {
      pending: pending.map(view),
      decided: decided.map(view).sort((a, b) => (b.decidedAt ?? "").localeCompare(a.decidedAt ?? "")),
      lastRun: request
        ? {
            requestedAt: request.requestedAt.toISOString(),
            status: request.status,
            stored: result.success ? (result.data.stored ?? null) : null,
            skipped: result.success ? (result.data.skipped ?? null) : null,
            error: result.success ? (result.data.error ?? null) : null,
          }
        : null,
      loadError: false,
    };
  } catch {
    return { pending: [], decided: [], lastRun: null, loadError: true };
  }
}
