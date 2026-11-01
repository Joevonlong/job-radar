/** The hash of a writing request's material (server only: node:crypto). */
import { createHash } from "node:crypto";

import type { WriterMaterials } from "./materials";

/** JSON with sorted keys, so the same material always hashes the same. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 (hex) of the material: kept on the request and the versions after the material itself is cleared. */
export function materialsHash(materials: WriterMaterials): string {
  return createHash("sha256").update(stableJson(materials)).digest("hex");
}
