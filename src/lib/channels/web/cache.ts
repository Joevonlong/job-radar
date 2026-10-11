/**
 * Per-cycle memo: the same posting shows up in several queries of one cycle (two cities, a
 * remote query, overlapping keywords), and each detail page costs a request. The memo is keyed by
 * the cycle's abort signal (one per cycle, shared by all its queries), so it disappears with the
 * cycle and never serves stale pages to the next one.
 */
export function createCycleCache<T>(): (signal: AbortSignal) => Map<string, T> {
  const cycles = new WeakMap<AbortSignal, Map<string, T>>();
  return (signal) => {
    let cache = cycles.get(signal);
    if (!cache) {
      cache = new Map();
      cycles.set(signal, cache);
    }
    return cache;
  };
}
