import { z } from "zod";

import { HIDDEN_METHODS, TRAP_AI_CHECK_MODES, TRAPS_CONFIG_VERSION } from "../traps-options";

import { nonEmptyString, nonNegativeNumber, positiveInt } from "./common";

/** Flags a pattern may carry; `g` is added by the code where it needs every match. */
const FLAGS = /^[imsu]*$/;

/** A regular expression source that compiles with its flags (checked at load time, so a broken pattern names its path). */
function compiles(source: string, flags: string): boolean {
  try {
    new RegExp(source, flags.includes("u") ? flags : `${flags}u`);
    return true;
  } catch {
    return false;
  }
}

const regexSource = nonEmptyString.refine((source) => compiles(source, "i"), "must be a valid regular expression");

/** One pattern of a language group: an id (shown on the detail page), the language it is written for and the expression. */
const languagePattern = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9_]*$/, "id must be lowercase letters, digits or underscores"),
    lang: z.string().regex(/^[a-z]{2}$/, "must be a two-letter language code"),
    pattern: nonEmptyString,
    /** Default `iu`. */
    flags: z.string().regex(FLAGS, "only i, m, s and u are allowed").default("iu"),
  })
  .superRefine((value, ctx) => {
    if (!compiles(value.pattern, value.flags)) ctx.addIssue({ code: "custom", path: ["pattern"], message: "must be a valid regular expression" });
  });

const uniqueIds = (list: ReadonlyArray<{ id: string }>, ctx: z.RefinementCtx): void => {
  const seen = new Set<string>();
  list.forEach((item, index) => {
    if (seen.has(item.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "must not contain duplicates" });
    seen.add(item.id);
  });
};

const cssColor = nonEmptyString.max(40);

/** config/traps.yaml: how Job Radar finds content in a JD that is written to mislead an AI, and what it does with it. */
export const trapsSchema = z.strictObject({
  /**
   * Version of this file's shape; a later shape change ships a migration. Optional here: the layered loader handles the key
   * itself and strips it before validation, an older loader passes it through.
   */
  config_version: z.literal(TRAPS_CONFIG_VERSION).optional(),
  /** false: no scan, no cleaning of what goes to the AI, nothing shown on the pages (stored findings stay). */
  enabled: z.boolean(),
  scan: z.strictObject({
    /** Most jobs one cycle scans (new jobs first); the rest waits for the next cycle or `pnpm traps:scan --write`. */
    per_cycle_limit: positiveInt,
    /** Hidden text shorter than this (characters, spaces squeezed) is ignored unless it holds an instruction. */
    min_hidden_chars: positiveInt,
    /** A quote that exists only in the source page is cut to this length. */
    quote_max_chars: positiveInt.min(40),
    /** Most findings stored per job (traps first). */
    max_findings_per_job: positiveInt,
    /** `pnpm run doctor` warns when more jobs than this wait for their first scan. */
    backlog_warn: positiveInt,
    /** `pnpm run doctor` also counts the jobs with traps among those first seen in this many days. */
    recent_days: positiveInt,
  }),
  hidden: z.strictObject({
    /** Each way of hiding text can be switched off on its own. */
    methods: z.strictObject(Object.fromEntries(HIDDEN_METHODS.map((m) => [m, z.boolean()])) as Record<(typeof HIDDEN_METHODS)[number], z.ZodBoolean>),
    color: z.strictObject({
      /** WCAG contrast ratio below which text counts as hidden (1 = same colour, 21 = black on white). */
      min_contrast: z.number().min(1).max(21),
      /** Page backgrounds assumed when no ancestor sets one inline (the text is compared with each). */
      assumed_background: z.array(cssColor).min(1),
    }),
    /** `opacity` at or below this hides. */
    opacity_max: z.number().min(0).max(1),
    /** `font-size` (or `line-height` with the overflow cut) at or below this many pixels hides. */
    font_size_max_px: nonNegativeNumber,
    /** A negative `left`, `top`, `margin-*` or `text-indent` of at least this many pixels moves the text off the screen. */
    offscreen_min_px: positiveInt,
    /** `width` / `height` at or below this many pixels together with `overflow: hidden` hides. */
    size_max_px: nonNegativeNumber,
    /** Class names that hide an element (no stylesheet is read: only these names count). */
    classes: z.array(z.string().regex(/^[A-Za-z0-9_-]+$/, "must be a CSS class name")),
    /** Hidden texts that are harmless (screen-reader hints such as "opens in a new tab"); matched against the whole text. */
    benign: z.array(regexSource),
  }),
  invisible_unicode: z.strictObject({
    /** Unicode tag characters (U+E0000-E007F): invisible ASCII, decoded and always reported as a trap. */
    tag_chars: z.boolean(),
    /** Zero-width characters inside a word. */
    zero_width: z.boolean(),
    /** How many zero-width characters one word needs before it counts (emoji joiners never count). */
    zero_width_min_run: positiveInt,
    /** Bidirectional override / isolate controls (U+202A-202E, U+2066-2069). */
    bidi_controls: z.boolean(),
  }),
  /** Language groups of `instructions` that are used (an instruction in another language is not looked for). */
  instruction_languages: z.array(z.string().regex(/^[a-z]{2}$/, "must be a two-letter language code")),
  /** Patterns of text addressed to an AI ("if you are an AI, ...", "ignore all previous instructions"); a hit is a trap. */
  instructions: z.array(languagePattern).superRefine(uniqueIds),
  ai_check: z.strictObject({
    /** flagged: only jobs the rules flagged; all: every job that passed the filter and is not scored yet; off: no AI check. */
    mode: z.enum(TRAP_AI_CHECK_MODES),
    /** Most jobs one cycle sends to the AI check. */
    per_cycle_limit: positiveInt,
    /** Longest JD (characters) sent to the check; a longer one keeps its beginning and its end. */
    jd_max_chars: positiveInt.min(500),
    /** Weaker patterns: not a finding by themselves, but they send the job to the AI check (mode flagged). */
    triggers: z.array(languagePattern).superRefine(uniqueIds),
  }),
  ai_input: z.strictObject({
    /** Replaces hidden text in everything sent to an AI. */
    hidden_marker: nonEmptyString.max(120),
    /** Replaces a visible instruction to the AI in everything sent to an AI. */
    instruction_marker: nonEmptyString.max(120),
  }),
});
export type TrapsConfig = z.infer<typeof trapsSchema>;
export type TrapPatternConfig = TrapsConfig["instructions"][number];
