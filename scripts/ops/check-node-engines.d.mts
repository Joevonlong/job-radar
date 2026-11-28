// Types for check-node-engines.mjs (plain JavaScript so it runs before any dependency is installed).
export type EnginesCheck =
  | { ok: true }
  | { ok: false; reason: "unsupported-range" | "bad-version"; message: string }
  | { ok: false; reason: "out-of-range"; min: [number, number, number]; message: string };

export function parseEnginesRange(range: string): { min: [number, number, number]; belowMajor: number } | null;
/** Checks a Node version such as "v26.13.1" against a range such as ">=26.13.1 <27". */
export function checkNodeEngines(range: string, version: string): EnginesCheck;
