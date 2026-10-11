import type { CSSProperties } from "react";

/** Colour roles the data-viz components accept. Mapped to CSS custom properties of docs/design/tokens.css. */
export type VizTone = "ink" | "meter" | "hi" | "good" | "warn" | "bad" | "t1" | "t2" | "t3" | "t4" | "violet" | "olive" | "pink" | "slate";

const TONE_VAR: Record<VizTone, string> = {
  ink: "var(--ink)",
  meter: "var(--meter)",
  hi: "var(--hi)",
  good: "var(--good)",
  warn: "var(--warn)",
  bad: "var(--bad)",
  t1: "var(--signal-t1)",
  t2: "var(--signal-t2)",
  t3: "var(--signal-t3)",
  t4: "var(--signal-t4)",
  // The extra signal category colours
  violet: "var(--signal-violet)",
  olive: "var(--signal-olive)",
  pink: "var(--signal-pink)",
  slate: "var(--signal-slate)",
};

/** The CSS value (`var(--hi)`) of a tone, for inline `--c` custom properties. */
export function toneVar(tone: VizTone): string {
  return TONE_VAR[tone];
}

/** Inline style carrying CSS custom properties (and, optionally, plain properties). */
export function cssVars(vars: Record<string, string | number | undefined>): CSSProperties {
  return vars as CSSProperties;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** A finite number, or null: the guard every component uses before drawing (C3: unknown is never 0). */
export function known(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Class names joined, skipping falsy ones. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Share of the scale, 0-100, kept inside the track. */
export function toPercent(value: number, min: number, max: number): number {
  if (max <= min) return 0;
  return clamp(((value - min) / (max - min)) * 100, 0, 100);
}

/** CSS-ready percentage with two decimals at most. */
export function pctStyle(value: number): string {
  return `${Math.round(value * 100) / 100}%`;
}

// ---------------------------------------------------------------- steps() utility (bars grow in whole steps, like a terminal refresh)

/** Step counts of the grow animations (docs/design/tokens.md: steps(6-8)). viz.css uses the same numbers. */
export const STEPS = { bar: 8, column: 6 } as const;

/** `style` for cell number `index`: viz.css delays its light-up by `index * var(--step)`. */
export function stepStyle(index: number, extra?: CSSProperties): CSSProperties {
  return { ...extra, ["--n" as string]: index } as CSSProperties;
}
