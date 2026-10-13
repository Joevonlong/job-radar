// Types for check-node-engines.mjs (plain JavaScript so it runs before any dependency is installed).
export type EnginesCheck =
  | { ok: true }
  | { ok: false; reason: "unsupported-range" | "bad-version" | "out-of-range"; message: string };

export function parseEnginesRange(range: string): { min: [number, number, number]; belowMajor: number } | null;
export function checkNodeEngines(range: string, version: string): EnginesCheck;
