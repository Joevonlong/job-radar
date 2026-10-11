/** Lay one messages tree over another: objects are merged key by key, a leaf of `over` replaces the one of `base`. Pure. */
export function deepMergeMessages<T>(base: T, over: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = key in base ? deepMergeMessages(base[key], value) : value;
  return out as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
