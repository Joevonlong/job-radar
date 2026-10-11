import type { JobCard } from "@/lib/db/queries/types";
import { parseFilterReason } from "@/lib/filter/reasons";

/** Ids of the listed jobs the hard filter removed for their salary: the only ones whose list line needs the floor of the time (`getFilterFloors`). */
export function salaryFilteredIds(cards: readonly Pick<JobCard, "id" | "rank">[]): number[] {
  return cards.filter((card) => card.rank?.filterResult === "filtered_out" && card.rank.filterReasons.some((reason) => parseFilterReason(reason).code === "salary_below_floor")).map((card) => card.id);
}
