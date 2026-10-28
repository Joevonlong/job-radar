/**
 * Which channels a processing cycle covers. A cycle (or a `run_cycle` request) carries the optional `channelIds` it is
 * limited to; absent or empty means every enabled channel. Used wherever one cycle could stand in for another: the web
 * reusing an open request, a scheduled cycle that finds the lock taken, a manual request that finds a cycle running.
 */
export type CycleChannelIds = readonly string[] | null | undefined;

/** A fallback chain of channels (sources.yaml `linkedin.cascade`): a cycle collects with the first of them it selects. */
export interface CoverageCascade {
  order: readonly string[];
}

const isAll = (ids: CycleChannelIds): ids is null | undefined | readonly [] => ids === null || ids === undefined || ids.length === 0;

/**
 * The channels a cycle limited to `ids` leads with, as the collect step builds its units: the named channels outside a
 * cascade, and per cascade only the first member it selects. A full cycle (`all`) runs every channel outside a cascade
 * and leads each cascade with its first member.
 */
function leaders(ids: CycleChannelIds, cascades: readonly CoverageCascade[]): { all: boolean; ids: Set<string> } {
  const members = new Set(cascades.flatMap((cascade) => cascade.order));
  const lead = new Set<string>();
  for (const cascade of cascades) {
    const first = isAll(ids) ? cascade.order[0] : cascade.order.find((id) => ids.includes(id));
    if (first !== undefined) lead.add(first);
  }
  if (!isAll(ids)) for (const id of ids) if (!members.has(id)) lead.add(id);
  return { all: isAll(ids), ids: lead };
}

/**
 * True when a cycle limited to `holder` also does everything one limited to `wanted` would. Outside a cascade that is
 * `wanted` ⊆ `holder`. A cascade collects with one member only, the first it selects, so a fallback member asked for by
 * name (a "collect now" of the second LinkedIn source) is covered only by a cycle that would lead with it too: a full
 * cycle leads with the cascade's first member and does not cover it.
 */
export function cycleCovers(holder: CycleChannelIds, wanted: CycleChannelIds, cascades: readonly CoverageCascade[] = []): boolean {
  if (isAll(wanted)) return isAll(holder);
  const held = leaders(holder, cascades);
  const want = leaders(wanted, cascades);
  for (const id of want.ids) {
    if (held.ids.has(id)) continue;
    // a full cycle runs every channel outside a cascade
    const inCascade = cascades.some((cascade) => cascade.order.includes(id));
    if (held.all && !inCascade) continue;
    return false;
  }
  return true;
}
