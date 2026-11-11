/** Per-card loaders never read extra job details; only the shared batch scan check guards derived summaries. */
import type { FieldBlock } from "@/lib/capabilities/blocks";
import type { TrapsConfig } from "@/lib/config/schemas/traps";
import { pickSummary, summaryOrder } from "@/lib/dashboard/summary";
import type { JobCard } from "@/lib/db/queries/types";
import { currentTrapScanJobIds } from "@/lib/db/repos/traps";
import type { StrictCleanFailure } from "@/lib/traps/clean";
import { rulesFingerprint } from "@/lib/traps/fingerprint";

import type { McpContext } from "./context";
import { cardMatchBlockDto, cardTrackingBlockDto } from "./dto/job-card-blocks";
import type { CleanText } from "./dto/shared";

interface CardBlockSource {
  card: JobCard;
  clean: CleanText;
  summaryFailure: StrictCleanFailure | null;
}

export const searchJobCardBlocks = [
  { key: "match", permission: "match:read", schema: cardMatchBlockDto, onRequest: false, load: async (ctx, { card, clean, summaryFailure }) => {
    const summary = card.summary ? pickSummary(card.summary.texts, summaryOrder(ctx.text.locale, card.summary.outputLang)) : null;
    return {
      summary: summary && summaryFailure === null ? clean(summary.text) : null,
      summary_lang: summary && summaryFailure === null ? clean(summary.lang) : null,
      summary_withheld: summary ? summaryFailure : null,
      filter_result: card.rank?.filterResult ?? null,
      filter_reasons: card.rank?.filterReasons.map(clean) ?? [],
    };
  } },
  { key: "tracking", permission: "tracking:read", schema: cardTrackingBlockDto, onRequest: false, load: async (_ctx, { card }) => ({
    status: card.applicationStatus ?? "new", favorite: card.favorite !== null, seen: card.seen,
  }) },
] as const satisfies readonly FieldBlock<CardBlockSource>[];

/** Without match permission no scan query runs; a failed read withholds every summary with the strict cleaner's reason. */
export async function summaryAccess(ctx: McpContext, cards: readonly JobCard[], traps: TrapsConfig | null): Promise<{ allowed: Set<number>; reason: StrictCleanFailure | null }> {
  const allowed = new Set<number>();
  if (!ctx.permissions?.has("match:read")) return { allowed, reason: null };
  if (traps === null) return { allowed, reason: "settings_unreadable" };
  if (!traps.enabled) return { allowed, reason: "traps_disabled" };
  try {
    return { allowed: await currentTrapScanJobIds(ctx.db, cards.map((card) => card.id), rulesFingerprint(traps)), reason: null };
  } catch {
    return { allowed, reason: "findings_unreadable" };
  }
}
