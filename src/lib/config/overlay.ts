import { isDeepStrictEqual } from "node:util";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The one thing used of a zod schema: parsing. */
interface Parser {
  safeParse(input: unknown): { success: boolean; data?: unknown };
}

/**
 * The part of a validated config worth writing to the user's file. `value` is what the schema returned: it holds every
 * key, including the ones the schema filled in from its own defaults. A key the user's file does not have (`existing`,
 * the plain value of that file) is left out when the schema gives it back unchanged without it: it is a default, and a
 * default written into the file would pin the value, so a later change of the shipped default never reaches the user.
 *
 * Keys the file already has are never touched (the user's own, even when equal to the default). Lists are one value:
 * their items are not looked at. The result always parses back to exactly `value`; `value` itself is not changed.
 */
export function pruneRedundantKeys<T>(schema: Parser, value: T, existing: unknown): T {
  const work = structuredClone(value);
  const readsBack = (): boolean => {
    const result = schema.safeParse(work);
    return result.success && isDeepStrictEqual(result.data, value);
  };
  const walk = (node: unknown, known: unknown): void => {
    if (!isPlainObject(node)) return;
    const knownMap = isPlainObject(known) ? known : {};
    for (const key of Object.keys(node)) {
      if (Object.hasOwn(knownMap, key)) {
        walk(node[key], knownMap[key]);
        continue;
      }
      const child = node[key];
      delete node[key];
      if (readsBack()) continue;
      node[key] = child;
      walk(child, {});
    }
  };
  walk(work, existing);
  return work;
}
