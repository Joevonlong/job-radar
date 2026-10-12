/**
 * What the pages and `pnpm ghost:check` show of a stored result: the checks panel row, the list mark's tooltip and each reason as a
 * message key of the `ghostJobs` namespace with its values (the pages render templates, nothing is stored as a sentence).
 */
import type { GhostLevel, GhostOfJob, GhostReason } from "./types";

/** A message of the `ghostJobs` namespace and its values. */
export interface GhostMessage {
  key:
    | "reason.long_open"
    | "reason.long_open_first_seen"
    | "reason.repost_label"
    | "reason.reposted"
    | "reason.evergreen_wording"
    | "reason.thin_short_none"
    | "reason.thin_short"
    | "reason.thin_none"
    | "reason.thin_none_breakdown"
    | "short.long_open"
    | "short.repost_label"
    | "short.reposted"
    | "short.evergreen_wording"
    | "short.thin_description";
  values: Record<string, string | number>;
}

/**
 * The full line of a reason (checks panel, CLI). `channelName` names a channel id ("greenhouse" → "Greenhouse"); the CLI keeps the
 * ids.
 */
export function ghostReasonMessage(reason: GhostReason, channelName: (channelId: string) => string = (id) => id): GhostMessage {
  switch (reason.code) {
    case "long_open":
      return reason.from === "posted"
        ? { key: "reason.long_open", values: { days: reason.days, date: reason.since, channel: reason.channelId === null ? "" : channelName(reason.channelId) } }
        : { key: "reason.long_open_first_seen", values: { days: reason.days } };
    case "repost_label":
      return { key: "reason.repost_label", values: { channel: channelName(reason.channelId), label: reason.label } };
    case "reposted": {
      const dates = [reason.events[0]?.oldSeen ?? "", ...reason.events.map((e) => e.newSeen)].filter((d) => d !== "");
      return { key: "reason.reposted", values: { channel: channelName(reason.channelId), dates: [...new Set(dates)].join(", ") } };
    }
    case "evergreen_wording":
      return { key: "reason.evergreen_wording", values: {} };
    case "thin_description": {
      const short = reason.words < reason.minWords;
      // `none`: the duties were not looked for, so only the length is named (a long JD is never a reason then)
      if (reason.responsibilitiesFrom === "none" || (short && reason.hasResponsibilities)) return { key: "reason.thin_short", values: { words: reason.words } };
      if (short) return { key: "reason.thin_short_none", values: { words: reason.words } };
      return { key: reason.responsibilitiesFrom === "breakdown" ? "reason.thin_none_breakdown" : "reason.thin_none", values: {} };
    }
  }
}

/** Reasons the mark's tooltip names (strongest first; the checks card lists all). */
export const GHOST_TOOLTIP_REASONS = 3;

/** The short form of a reason (the list mark's tooltip: "open 214 days · relisted under a new id"). */
export function ghostShortMessage(reason: GhostReason): GhostMessage {
  if (reason.code === "long_open") return { key: "short.long_open", values: { days: reason.days } };
  if (reason.code === "thin_description") return { key: "short.thin_description", values: {} };
  return { key: `short.${reason.code}`, values: {} };
}

export type GhostCheckState = "clear" | "watch" | "likely" | "dismissed" | "not_checked";
export type GhostCheckTone = "good" | "warn" | "dim";

export interface GhostCheckView {
  state: GhostCheckState;
  /** The stored level (also when dismissed); null before the check. */
  level: GhostLevel | null;
  score: number;
  tone: GhostCheckTone;
  reasons: GhostReason[];
  /** The evergreen quote, for the JD mark and "View in the original". */
  quote: string | null;
  /** "Not a ghost job" shows (a watch / likely result not dismissed). */
  canDismiss: boolean;
  /** "Undo" shows (a dismissal that still holds). */
  canUndo: boolean;
}

export function buildGhostCheckView(detail: GhostOfJob | null): GhostCheckView {
  if (detail === null) return { state: "not_checked", level: null, score: 0, tone: "dim", reasons: [], quote: null, canDismiss: false, canUndo: false };
  const quote = detail.reasons.find((r) => r.code === "evergreen_wording");
  const base = { level: detail.level, score: detail.score, reasons: detail.reasons, quote: quote?.code === "evergreen_wording" ? quote.quote : null };
  if (detail.level === "none") return { ...base, state: "clear", tone: "good", canDismiss: false, canUndo: false };
  if (detail.dismissed) return { ...base, state: "dismissed", tone: "dim", canDismiss: false, canUndo: true };
  return { ...base, state: detail.level, tone: detail.level === "likely" ? "warn" : "dim", canDismiss: true, canUndo: false };
}

/** The text the JD panel marks for a quote: its first line (the JD panel marks within one line). */
export function ghostMarkText(quote: string): string {
  return (quote.split("\n")[0] ?? quote).trim();
}
