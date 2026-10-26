import type { PipelineConfig } from "@/lib/config";
import { resolveCompanyName } from "@/lib/pipeline/company";

/** The part of an `ats_boards` entry that decides whether a company has a board. */
export interface BoardName {
  name: string;
  enabled: boolean;
}

export interface WatchedCompanyBoard {
  /** The name as the watch list first spells it. */
  name: string;
  /** The push step's company key (`resolveCompanyName(...).nameNorm`). */
  key: string;
  /** An enabled ATS board carries the same company key: the board is read whole, whatever the city. */
  hasBoard: boolean;
}

/**
 * Which watched companies have an ATS board. Names are compared by the push step's company key (case, legal form and
 * aliases ignored), so "Anthropic PBC" in the watch list and a board named "Anthropic" are the same company. One entry
 * per key, in the order of the list; a disabled board does not count.
 */
export function watchedCompanyBoards(watchedCompanies: readonly string[], atsBoards: readonly BoardName[], pipeline: PipelineConfig): WatchedCompanyBoard[] {
  const boardKeys = new Set(atsBoards.filter((board) => board.enabled).map((board) => resolveCompanyName(board.name, pipeline).nameNorm));
  const seen = new Set<string>();
  const out: WatchedCompanyBoard[] = [];
  for (const name of watchedCompanies) {
    const key = resolveCompanyName(name, pipeline).nameNorm;
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    out.push({ name, key, hasBoard: boardKeys.has(key) });
  }
  return out;
}
