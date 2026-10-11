import type { VizTone } from "@/components/viz";
import type { BoardColumn } from "@/lib/dashboard/board";

/**
 * Column colours = application status colours (docs/design/design-system.html "申请状态"). Tokens only:
 * `dot` is a Tailwind background utility for the square in the column head, `tone` the matching data-viz tone.
 */
export const COLUMN_COLOR: Record<BoardColumn, { dot: string; tone: VizTone }> = {
  new: { dot: "bg-soft", tone: "ink" },
  interested: { dot: "bg-hi", tone: "hi" },
  preparing: { dot: "bg-signal-t4", tone: "t4" },
  applied: { dot: "bg-signal-t3", tone: "t3" },
  interviewing: { dot: "bg-signal-t2", tone: "t2" },
  offer: { dot: "bg-good", tone: "good" },
  ended: { dot: "bg-ink-3", tone: "ink" },
};
