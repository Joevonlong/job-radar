/**
 * The fixed colour palette of signal categories. A category picks one of these names in interests.yaml; every
 * place that paints a category takes its classes from here. The classes are written out literally (never built from
 * strings), so Tailwind sees them. Pure constants: client and server share it.
 *
 * amber / teal / coral / blue are the four colours the tiers T1-T4 always had (`--signal-t1..t4`); olive / violet / slate /
 * pink are new tokens (`--signal-violet` ...), defined for the paper and the terminal theme in globals.css; `neutral`
 * is the plain look of the benefit tags.
 */
import type { VizTone } from "@/components/viz/util";

/** In picker order (the order the colours were checked for adjacent contrast in). */
export const SIGNAL_COLORS = ["amber", "teal", "coral", "blue", "olive", "violet", "slate", "pink", "neutral"] as const;
export type SignalColor = (typeof SIGNAL_COLORS)[number];

export interface SignalColorClasses {
  /** Solid block with ink text: JD highlight, its legend, the code part of a signal tag, cap bar pieces. */
  solid: string;
  /** Solid fill only (cap bar piece, swatch). */
  bg: string;
  /** Tinted badge (list rows): border, 15% fill and text. */
  tint: string;
  /** Left border of a quote. */
  quoteBorder: string;
  /** Tone of the viz components (weight cells, signal bars). */
  tone: VizTone;
  /** The CSS colour, for inline swatches. */
  cssVar: string;
}

export const SIGNAL_COLOR_CLASSES: Readonly<Record<SignalColor, SignalColorClasses>> = {
  amber: { solid: "bg-signal-t1 text-on-signal", bg: "bg-signal-t1", tint: "border-signal-t1/30 bg-signal-t1/15 text-signal-t1-text", quoteBorder: "border-signal-t1", tone: "t1", cssVar: "var(--signal-t1)" },
  teal: { solid: "bg-signal-t2 text-on-signal", bg: "bg-signal-t2", tint: "border-signal-t2/30 bg-signal-t2/15 text-signal-t2-text", quoteBorder: "border-signal-t2", tone: "t2", cssVar: "var(--signal-t2)" },
  coral: { solid: "bg-signal-t3 text-on-signal", bg: "bg-signal-t3", tint: "border-signal-t3/30 bg-signal-t3/15 text-signal-t3-text", quoteBorder: "border-signal-t3", tone: "t3", cssVar: "var(--signal-t3)" },
  blue: { solid: "bg-signal-t4 text-on-signal", bg: "bg-signal-t4", tint: "border-signal-t4/30 bg-signal-t4/15 text-signal-t4-text", quoteBorder: "border-signal-t4", tone: "t4", cssVar: "var(--signal-t4)" },
  violet: { solid: "bg-signal-violet text-on-signal", bg: "bg-signal-violet", tint: "border-signal-violet/30 bg-signal-violet/15 text-ink", quoteBorder: "border-signal-violet", tone: "violet", cssVar: "var(--signal-violet)" },
  olive: { solid: "bg-signal-olive text-on-signal", bg: "bg-signal-olive", tint: "border-signal-olive/30 bg-signal-olive/15 text-ink", quoteBorder: "border-signal-olive", tone: "olive", cssVar: "var(--signal-olive)" },
  pink: { solid: "bg-signal-pink text-on-signal", bg: "bg-signal-pink", tint: "border-signal-pink/30 bg-signal-pink/15 text-ink", quoteBorder: "border-signal-pink", tone: "pink", cssVar: "var(--signal-pink)" },
  slate: { solid: "bg-signal-slate text-on-signal", bg: "bg-signal-slate", tint: "border-signal-slate/30 bg-signal-slate/15 text-ink", quoteBorder: "border-signal-slate", tone: "slate", cssVar: "var(--signal-slate)" },
  neutral: { solid: "bg-grid text-ink", bg: "bg-grid", tint: "border-border bg-muted text-muted-foreground", quoteBorder: "border-grid", tone: "ink", cssVar: "var(--grid)" },
};

export function isSignalColor(value: string): value is SignalColor {
  return (SIGNAL_COLORS as readonly string[]).includes(value);
}

/** The classes of a colour; an unknown name (never valid in the config) falls back to neutral. */
export function signalColorClasses(color: string): SignalColorClasses {
  return isSignalColor(color) ? SIGNAL_COLOR_CLASSES[color] : SIGNAL_COLOR_CLASSES.neutral;
}
