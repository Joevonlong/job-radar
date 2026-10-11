import { useTranslations } from "next-intl";

import { formatInteger, formatPercent, ratioPercent, UNKNOWN } from "@/lib/format/numbers";

import "./viz.css";
import { useAppLocale } from "./intl";
import { PlayOnView } from "./motion";
import { NumberRoll } from "./number-roll";
import { cssVars, cx, pctStyle, toneVar, type VizTone } from "./util";

export interface FunnelStep {
  key: string;
  label: string;
  value: number;
  tone?: VizTone;
}

export interface FunnelProps {
  /** From the widest stage to the narrowest: fetched, passed the filter, scored 70 or more, pushed. */
  steps: readonly FunnelStep[];
  className?: string;
}

/**
 * One bar per stage, widths relative to the first, and the conversion rate (↓ 29%) between stages. A stage with 0 has no bar at
 * all (an empty outline track, `data-zero`): the narrowest drawn bar is 4% so that 1 of 458 stays visible, but a zero must not
 * look like one.
 */
export function Funnel({ steps, className }: FunnelProps) {
  const t = useTranslations("viz");
  const locale = useAppLocale();
  const first = steps[0]?.value ?? 0;
  const summary = steps.map((step) => `${step.label} ${formatInteger(step.value, locale)}`).join(", ");
  return (
    <PlayOnView as="div" className={cx("jr-fun", className)} role="group" aria-label={t("funnel.aria", { steps: summary })}>
      {steps.map((step, index) => {
        const previous = steps[index - 1];
        const conversion = previous ? ratioPercent(step.value, previous.value) : null;
        const zero = step.value <= 0;
        const width = zero ? null : first > 0 ? Math.max(4, (step.value / first) * 100) : 4;
        return (
          <div key={step.key} style={{ display: "contents" }}>
            {previous ? (
              <div className="jr-fun__r">
                <span />
                <span className="jr-fun__cv">{t("funnel.conversion", { value: conversion === null ? UNKNOWN : formatPercent(conversion) })}</span>
                <span />
              </div>
            ) : null}
            <div className="jr-fun__r">
              <b>{step.label}</b>
              <span
                className={cx("jr-fun__bar jr-tip", zero ? "jr-fun__bar--zero" : "jr-grow")}
                data-zero={zero ? "true" : undefined}
                data-tip={t("funnel.tip", { label: step.label, value: formatInteger(step.value, locale) })}
                style={cssVars({ "--k": index, "--c": toneVar(step.tone ?? "ink"), ...(width === null ? {} : { width: pctStyle(width) }) })}
              />
              <span className="jr-fun__v">
                <NumberRoll value={step.value} />
              </span>
            </div>
          </div>
        );
      })}
    </PlayOnView>
  );
}
