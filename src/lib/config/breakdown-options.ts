/**
 * The fixed choices of `config/breakdown.yaml`: the zod schema and the settings dropdown share them.
 * Plain constants without zod, so the browser bundle can import them.
 */
export const BREAKDOWN_MODES = ["manual", "auto"] as const;
export type BreakdownMode = (typeof BREAKDOWN_MODES)[number];
