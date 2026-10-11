import { useTranslations } from "next-intl";

import { PlayOnView } from "@/components/viz/motion";
import { cssVars, cx, pctStyle } from "@/components/viz/util";
import { capBar, type CapEntry } from "@/lib/dashboard/cap-bar";
import { formatScoreValue } from "@/lib/format/numbers";
import { signalColorClasses } from "@/lib/signals/palette";

/**
 * The bar under "pay and benefits" (design `.capbar`): the categories that count stacked in category order (their colours), what goes over
 * `bonus_cap` hatched, a red line at the cap, and the points that count (the signal bonus of the rank value) at the end.
 * The piece widths are points over the longer of the total and the cap.
 */
export function CapBar({ tiers, cap, className }: { tiers: readonly CapEntry[]; cap: number; className?: string }) {
  const t = useTranslations("dashboard.detail.comp");
  const bar = capBar(tiers, cap);
  const total = formatScoreValue(bar.total);
  const counted = formatScoreValue(bar.counted);
  const label = bar.capped ? t("capLabelCapped", { total, cap }) : t("capLabel", { total, cap });

  return (
    <div className={cx("border-border border-t-bw grid items-center gap-x-3 gap-y-1.5 pt-3 [grid-template-columns:minmax(0,1fr)_auto]", className)} data-testid="cap-bar" data-total={bar.total} data-counted={bar.counted} data-capped={bar.capped}>
      <span className="text-data text-ink-2 col-span-2 font-mono" data-testid="bonus-line">
        {label}
      </span>
      <PlayOnView as="div" className="border-bw border-border bg-card relative flex h-[22px] overflow-visible rounded-[5px]" role="img" aria-label={t("capAria", { total, cap, counted })}>
        <span className="flex size-full overflow-hidden rounded-[3px]">
          {bar.pieces.map((piece, index) => (
            <i
              key={piece.id}
              className={cx("jr-grow border-r-bw border-border relative flex h-full min-w-0 items-center overflow-hidden not-italic last:border-r-0", signalColorClasses(piece.color).bg)}
              style={cssVars({ width: pctStyle(piece.width), "--k": index })}
              title={`${piece.label} +${formatScoreValue(piece.points)}`}
              data-tier={piece.id}
            >
              <span className={cx("text-data-sm px-1.5 font-mono font-bold whitespace-nowrap", piece.color === "neutral" ? "text-ink" : "text-on-signal")}>{piece.code ?? ""}</span>
              {piece.over > 0 ? <span aria-hidden className="jr-hatch text-ink-3 bg-card absolute inset-y-0 right-0" style={{ width: pctStyle(piece.overShare) }} /> : null}
            </i>
          ))}
        </span>
        <u aria-hidden className="bg-bad absolute -top-0.5 -bottom-0.5 w-[3px] -translate-x-1/2 no-underline" style={{ left: pctStyle(bar.capAt) }} />
      </PlayOnView>
      <b className="font-display text-num-s" data-testid="cap-bar-bonus">
        +{counted}
      </b>
    </div>
  );
}
