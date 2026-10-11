/**
 * One mapping from "how a channel is doing" to a state colour, shared by the Today channel chips and the /sources cards:
 * red only for failures (a failed run, an open circuit); a missing optional key or a skipped run is yellow ("it did nothing, you may want to
 * fix it"); green is only for a channel that did its job. The words next to the colour say the same.
 */
import type { ChannelStatus } from "./view";

export type ChannelTone = "good" | "warn" | "bad" | "idle";

/** The card's status word of /sources -> the colour of its light. */
export function statusTone(status: ChannelStatus): ChannelTone {
  switch (status) {
    case "ok":
      return "good";
    case "degraded":
    case "half_open":
    case "missing_credentials":
      return "warn";
    case "failing":
    case "open":
      return "bad";
    case "off":
    case "not_registered":
    case "idle":
      return "idle";
  }
}

/** A channel's result in one cycle (Today's chip) -> the colour of its dot. A missing key beats "ok": the channel cannot have fetched anything. */
export function outcomeTone(input: { outcome: "ok" | "failed" | "skipped" | "circuit_open"; keyMissing: boolean }): ChannelTone {
  if (input.outcome === "failed" || input.outcome === "circuit_open") return "bad";
  if (input.outcome === "skipped" || input.keyMissing) return "warn";
  return "good";
}

/** Text colour of the status word (on paper). Yellow text is the darkened `warning-text`; red is `bad`. */
export const TONE_TEXT: Record<ChannelTone, string> = { good: "text-ink", warn: "text-warning-text", bad: "text-bad", idle: "text-ink-3" };

/** Background colour of a small dot. */
export const TONE_DOT: Record<ChannelTone, string> = { good: "bg-success", warn: "bg-warning", bad: "bg-destructive", idle: "bg-grid" };
