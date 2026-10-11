import { useTranslations } from "next-intl";

import { formatDelta, UNKNOWN } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { clamp, cssVars, cx, known, pctStyle } from "./util";

export interface DeltaProps {
  /** Change against the previous round. Null: a dashed `—` tag (not "no change"). */
  value: number | null | undefined;
  /** Appended to the number: `pt`, `%`. */
  unit?: "" | "pt" | "%";
  /** Up is bad (failures, filtered): swap the colours, keep the arrow. */
  invert?: boolean;
  className?: string;
}

/** ▲ +12 · ▼ −3 · ■ 0. Arrow, sign and number all say it; colour is the fourth cue. */
export function Delta({ value, unit = "", invert = false, className }: DeltaProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const delta = formatDelta(value, unit, locale);
  if (delta === null) {
    return (
      <span className={cx("jr jr-delta jr-delta--unknown", className)} role="img" aria-label={t("delta.unknown")} data-direction="unknown">
        {UNKNOWN}
      </span>
    );
  }
  const tone = delta.direction === "flat" ? "flat" : (delta.direction === "up") !== invert ? "up" : "down";
  const label = delta.direction === "up" ? t("delta.up", { value: delta.text.replace(/^\+/, "") }) : delta.direction === "down" ? t("delta.down", { value: delta.text.replace(/^−/, "") }) : t("delta.flat");
  return (
    <span className={cx("jr jr-delta", `jr-delta--${tone}`, className)} role="img" aria-label={label} data-direction={delta.direction}>
      <span aria-hidden>{delta.symbol}</span>
      <span aria-hidden>{delta.text}</span>
    </span>
  );
}

export interface PairBarsProps {
  /** Previous round (hatched bar) and this round (solid bar), same unit. Null: that bar is a dashed empty one. */
  prev: number | null | undefined;
  now: number | null | undefined;
  /** What a full bar is. Default: the larger of the two. */
  max?: number;
  /** Show the Delta tag next to the bars (default off: the page usually has its own). */
  showDelta?: boolean;
  /** Text next to the bars, e.g. `通过率 36% → 38%`. Default: `123 → 135`. */
  caption?: string;
  className?: string;
}

/** Two thin bars: hatched = previous round, solid = this round. Hover says both numbers. */
export function PairBars({ prev, now, max, showDelta = false, caption, className }: PairBarsProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const top = max ?? Math.max(known(prev) ? prev : 0, known(now) ? now : 0, 1);
  const width = (value: number | null | undefined): string => pctStyle(known(value) ? clamp((value / top) * 100, 0, 100) : 0);
  const prevText = known(prev) ? String(prev) : UNKNOWN;
  const nowText = known(now) ? String(now) : UNKNOWN;
  // An unknown round is a dashed empty track (unknown looks different from zero); zero is no bar at all.
  const barLook = (value: number | null | undefined): Record<string, string> => (!known(value) ? { borderStyle: "dashed", minWidth: "100%" } : value === 0 ? { borderWidth: "0" } : {});
  const change = known(prev) && known(now) ? formatDelta(now - prev, "", locale) : null;
  return (
    <PlayOnView className={cx("jr-pair-wrap", className)}>
      <span className="jr-pair jr-tip" role="img" aria-label={t("pair.aria", { prev: prevText, now: nowText })} data-tip={t("pair.tip", { prev: prevText, now: nowText })}>
        <i className="jr-grow" style={cssVars({ width: width(prev), ...barLook(prev) })} />
        <i className="jr-grow" style={cssVars({ "--k": 1, width: width(now), ...barLook(now) })} />
      </span>
      <span className="jr-data-sm">{caption ?? `${prevText} → ${nowText}`}</span>
      {showDelta ? <Delta value={change === null ? null : (now as number) - (prev as number)} /> : null}
    </PlayOnView>
  );
}
