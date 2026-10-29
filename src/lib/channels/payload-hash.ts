import { createHash } from "node:crypto";

/** Keys sorted recursively so equal payloads hash equally whatever order the source used. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** SHA-256 (hex) over canonical JSON after a JSON round trip (Dates become strings, undefined is dropped). */
export function hashPayload(payload: unknown): string {
  const normalized: unknown = JSON.parse(JSON.stringify(payload));
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}
