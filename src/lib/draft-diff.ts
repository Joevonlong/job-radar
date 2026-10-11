/**
 * Which fields of a form draft differ from the saved one (the yellow "changed" mark and the unsaved count
 * of the save bar). Pure; works on the drafts of /settings, /me and /interests (plain strings, booleans, lists
 * and nested records of them).
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Dotted paths of the leaves that differ between `current` and `initial`. A record is compared key by key;
 * a list or a plain value as a whole (one changed tag marks its field once, not once per tag).
 */
export function changedPaths(current: unknown, initial: unknown, prefix = ""): string[] {
  if (isRecord(current) && isRecord(initial)) {
    const keys = new Set([...Object.keys(current), ...Object.keys(initial)]);
    return [...keys].flatMap((key) => changedPaths(current[key], initial[key], prefix === "" ? key : `${prefix}.${key}`));
  }
  return JSON.stringify(current) === JSON.stringify(initial) ? [] : [prefix];
}
