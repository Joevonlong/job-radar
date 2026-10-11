import { createHash } from "node:crypto";

/**
 * md5 of the parts joined with ":" (strings as they are, anything else as JSON; null and undefined as ""). The same as
 * `md5(concat_ws(':', …))` in SQL over the same strings, so a candidate query can compare it with the stored hash.
 */
export function inputHash(parts: readonly unknown[]): string {
  const text = parts.map((part) => (part === null || part === undefined ? "" : typeof part === "string" ? part : JSON.stringify(part))).join(":");
  return createHash("md5").update(text).digest("hex");
}

/** md5 of a text as Postgres `md5(coalesce(text, ''))` computes it. */
export function textHash(text: string | null): string {
  return createHash("md5").update(text ?? "").digest("hex");
}
