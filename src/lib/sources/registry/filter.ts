/** Filtering of the registry rows by the URL state. Pure. */
import type { AtsKind } from "./entries";
import { REGISTRY_QUERY_MAX, type RegistryTypeFilter } from "./params";
import type { RegistryStatus } from "./status";
import { sortBoards } from "./board-sort";
import type { BoardRow, ChannelRow } from "./view";

export interface RegistryFilters {
  type: RegistryTypeFilter;
  statuses: readonly RegistryStatus[];
  ats: AtsKind | null;
  q: string;
}

const norm = (text: string): string => text.trim().toLowerCase();

function matchesText(q: string, fields: readonly string[]): boolean {
  const needle = norm(q.slice(0, REGISTRY_QUERY_MAX));
  return needle === "" || fields.some((field) => field.toLowerCase().includes(needle));
}

/** The channel and board rows that pass the filters; boards come sorted (failing first). */
export function filterRegistryRows(rows: { channels: readonly ChannelRow[]; boards: readonly BoardRow[] }, filters: RegistryFilters): { channels: ChannelRow[]; boards: BoardRow[] } {
  const statusOk = (status: RegistryStatus): boolean => filters.statuses.length === 0 || filters.statuses.includes(status);
  const channels =
    filters.type === "ats_board" ? [] : rows.channels.filter((row) => statusOk(row.status) && matchesText(filters.q, [row.id, row.name]) && (filters.ats === null || row.id === filters.ats));
  const boards =
    filters.type === "channel" ? [] : sortBoards(rows.boards.filter((row) => statusOk(row.status) && (filters.ats === null || row.ats === filters.ats) && matchesText(filters.q, [row.id, row.name, row.token, row.ats])));
  return { channels, boards };
}

/** The discovered boards that pass the search text and the ATS filter (the status filter has nothing to say about a board that is not listed yet; a channels-only view shows none). */
export function filterCandidates<T extends { ats: string; token: string; name: string }>(candidates: readonly T[], filters: Pick<RegistryFilters, "type" | "ats" | "q">): T[] {
  if (filters.type === "channel") return [];
  return candidates.filter((c) => (filters.ats === null || c.ats === filters.ats) && matchesText(filters.q, [c.name, c.token, c.ats]));
}
