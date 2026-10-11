/**
 * The fixed choices of `config/traps.yaml`: the zod schema and the trap module share them. Plain constants without zod,
 * so the browser bundle can import them.
 */

/** How the AI layer picks the jobs it checks: only the ones the rules flagged, every unscored job that passed the filter, or none. */
export const TRAP_AI_CHECK_MODES = ["flagged", "all", "off"] as const;
export type TrapAiCheckMode = (typeof TRAP_AI_CHECK_MODES)[number];

/** The ways an element can hide its text with inline styles and attributes (each can be switched off in traps.yaml). */
export const HIDDEN_METHODS = [
  "color_match",
  "display_none",
  "visibility_hidden",
  "opacity",
  "font_size",
  "offscreen",
  "clip",
  "zero_size",
  "hidden_attribute",
  "aria_hidden",
  "hidden_class",
] as const;
export type HiddenMethod = (typeof HIDDEN_METHODS)[number];

/** Highest `config_version` of traps.yaml this code reads. */
export const TRAPS_CONFIG_VERSION = 1;
