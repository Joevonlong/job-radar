/**
 * Which channels a processing cycle covers. A cycle (or a `run_cycle` request) carries the optional `channelIds` it is
 * limited to; absent or empty means every enabled channel. Used wherever one cycle could stand in for another: the web
 * reusing an open request, a scheduled cycle that finds the lock taken, a manual request that finds a cycle running.
 */
export type CycleChannelIds = readonly string[] | null | undefined;

/** True when a cycle limited to `holder` also does everything one limited to `wanted` would (`wanted` ⊆ `holder`). */
export function cycleCovers(holder: CycleChannelIds, wanted: CycleChannelIds): boolean {
  if (holder === null || holder === undefined || holder.length === 0) return true;
  if (wanted === null || wanted === undefined || wanted.length === 0) return false;
  const held = new Set(holder);
  return wanted.every((id) => held.has(id));
}
