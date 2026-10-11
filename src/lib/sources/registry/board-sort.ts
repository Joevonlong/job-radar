/** The board table's order, in a module of its own so client components can use it without the channel registry (which reads the market). */
import { STATUS_SEVERITY } from "./status";
import type { BoardRow } from "./view";

/** Sort for the board table: failing, unstable, never run, ok, off; then by name. */
export function sortBoards(rows: readonly BoardRow[]): BoardRow[] {
  return [...rows].sort((a, b) => STATUS_SEVERITY[a.status] - STATUS_SEVERITY[b.status] || a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
}
