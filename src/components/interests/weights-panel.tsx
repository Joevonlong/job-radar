"use client";

import { useTranslations } from "next-intl";

import { Field, describedBy } from "@/components/profile/fields";
import { Input } from "@/components/ui/input";
import { cx } from "@/components/viz/util";
import { capBar, weightScale } from "@/lib/interests/cap-bar";
import { signalColorClasses, type SignalColor } from "@/lib/signals/palette";

export { stepWeight } from "./category-row";

/** One category as the cap bar stacks it. */
export interface WeightBarEntry {
  id: string;
  name: string;
  /** As typed. */
  weight: string;
  color: SignalColor;
}

interface WeightsPanelProps {
  base: string;
  entries: readonly WeightBarEntry[];
  bonusCap: string;
  capError: string | undefined;
  onCap: (text: string) => void;
}

/**
 * The bonus cap (design system `s-interests`): every category's weight stacked on one bar in category order and
 * colour, the cap as a red line, the part past the cap hatched, and the cap field. The weights themselves are edited in
 * each category's row; the bar follows the draft as it is typed. Save recomputes the rank values (no AI).
 */
export function WeightsPanel({ base, entries, bonusCap, capError, onCap }: WeightsPanelProps) {
  const t = useTranslations("interests");
  const weights = entries.map((entry) => ({ id: entry.id, weight: entry.weight }));
  const bar = capBar(weights, bonusCap);
  const scale = weightScale(weights);
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  return (
    <fieldset className="flex flex-col gap-3" data-testid="weights-panel">
      <legend className="text-label mb-1 font-bold">{t("weights.title")}</legend>
      <p className="text-ink-2 text-body-sm">{t("weights.hint")}</p>
      <p className="text-ink-3 font-mono text-data-sm" data-testid="weight-scale" data-per-cell={scale.perCell}>
        {t("weights.cellScale", { perCell: scale.perCell, max: scale.max })}
      </p>
      <div className="border-grid grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 border-t-bw pt-3" data-testid="cap-bar" data-sum={bar.sum} data-counted={bar.counted}>
        <span className="font-mono text-data">{t("weights.capBar", { sum: bar.sum })}</span>
        <span
          className="border-border bg-card-bg rounded-tag border-bw relative flex h-[1.375rem] overflow-hidden"
          role="meter"
          aria-label={t("weights.capAria", { sum: bar.sum, counted: bar.counted, cap: bar.cap ?? "—" })}
          aria-valuemin={0}
          aria-valuemax={bar.cap ?? bar.sum}
          aria-valuenow={bar.counted}
          aria-valuetext={bar.over > 0 ? `${bar.counted} · ${t("weights.capOver", { over: bar.over })}` : String(bar.counted)}
        >
          {bar.segments.map((segment) => {
            const entry = byId.get(segment.id);
            return (
              <i
                key={segment.id}
                className={cx("border-border h-full border-r-bw transition-[width] duration-base", signalColorClasses(entry?.color ?? "neutral").bg)}
                data-tier={segment.id}
                title={entry ? `${entry.name} +${segment.value}` : undefined}
                style={{ width: `${segment.width}%` }}
              />
            );
          })}
          {bar.overflow ? <span className="jr-hatch text-ink absolute inset-y-0 opacity-55" data-testid="cap-overflow" style={{ left: `${bar.overflow.left}%`, width: `${bar.overflow.width}%` }} /> : null}
          {bar.capAt !== null ? <u className="bg-bad absolute inset-y-0 z-10 w-1 -translate-x-1/2 no-underline transition-[left] duration-base" data-testid="cap-line" style={{ left: `${bar.capAt}%`, ...(bar.capAt >= 100 ? { translate: "-100% 0" } : {}) }} /> : null}
        </span>
        <b className="font-display text-num-s" data-testid="cap-counted">
          +{bar.counted}
        </b>
        <span aria-hidden className="text-ink-3 col-start-2 flex justify-between font-mono text-data-sm" data-testid="cap-scale">
          <span>0</span>
          {bar.cap !== null && bar.cap < bar.scale ? <span>{t("weights.capTip", { cap: bar.cap })}</span> : null}
          <span>{bar.scale}</span>
        </span>
        <span className="text-ink-3 col-span-3 font-mono text-data-sm">{[bar.over > 0 ? `${t("weights.capHatch")} · ${t("weights.capOver", { over: bar.over })}` : t("weights.capHint"), t("weights.capScale", { scale: bar.scale })].join(" · ")}</span>
      </div>
      <div className="grid max-w-48">
        <Field id={`${base}-cap`} label={t("weights.cap")} {...(capError ? { errorText: capError } : {})}>
          <Input
            id={`${base}-cap`}
            inputMode="decimal"
            className="font-mono tabular-nums"
            value={bonusCap}
            aria-invalid={capError !== undefined || undefined}
            aria-describedby={describedBy(`${base}-cap`, false, capError)}
            onChange={(event) => onCap(event.target.value)}
          />
        </Field>
      </div>
    </fieldset>
  );
}
