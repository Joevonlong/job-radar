/** What the research bar shows of one job. No server code: the client component reads this too. */
import { RESEARCH_ITEMS, type ResearchItem } from "@/lib/config/schemas/research";

export type ResearchItemStatus =
  /** A result exists; `expired`: it is out of date and shown as such. */
  | { state: "done"; ageDays: number; expired: boolean }
  /** `auto`: queued automatically; while it is still `pending` a press moves it to the interactive lane. */
  | { state: "running"; stage: "pending" | "running"; auto: boolean }
  /** Paused by the AI usage cap until about `resumeAt`, if that is known. */
  | { state: "deferred"; resumeAt: string | null }
  | { state: "failed"; error: string }
  /** Cannot run until the user changes something on that settings tab. */
  | { state: "off"; settingsTab: "ai" | "salary" | "breakdown" }
  /** The job has no JD text, so this part has nothing to work on. */
  | { state: "unavailable" }
  | { state: "missing" };

export interface ResearchBarStatus {
  /** research.enabled: the buttons are there. When off, only stored results are listed. */
  canRequest: boolean;
  items: Partial<Record<ResearchItem, ResearchItemStatus>>;
}

/** An automatic request nothing has picked up yet: pressing the part moves it up. */
export function canMoveUp(item: ResearchItemStatus | undefined): boolean {
  return item?.state === "running" && item.auto && item.stage === "pending";
}

/** What "Research all" asks for: every part except one that is off, has nothing to work on, or is already being worked on for the user. */
export function researchAllItems(status: ResearchBarStatus | null): ResearchItem[] {
  return RESEARCH_ITEMS.filter((name) => {
    const item = status?.items[name];
    return item?.state !== "off" && item?.state !== "unavailable" && (item?.state !== "running" || canMoveUp(item));
  });
}
