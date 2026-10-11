import { useTranslations } from "next-intl";

import { Delta, NumberRoll, PercentBar, Sparkline, type VizTone } from "@/components/viz";
import type { KpiBlock, KpiKey } from "@/lib/dashboard/kpi";
import { formatPercent } from "@/lib/format/numbers";

import "./jobs.css";

/** Tone of a block's share bar and of the chip in front of its label (the first block is yellow, the rest follow the funnel). */
const BLOCK_TONE: Record<KpiKey, VizTone> = { fetched: "ink", passed: "t4", qualified: "meter", salary: "hi", pushed: "t2" };
const BLOCK_VAR: Record<KpiKey, string> = { fetched: "var(--ink)", passed: "var(--signal-t4)", qualified: "var(--meter)", salary: "var(--hi)", pushed: "var(--signal-t2)" };

export interface KpiStripProps {
  blocks: readonly KpiBlock[];
  /** "Evening 17:38": which cycle the numbers are from. */
  cycleLabel: string;
  /** The time part of `cycleLabel` ("17:38"): on a phone the block shows only this, like the design. */
  cycleTime?: string;
  /** Channels that took part in the cycle (the first block says "14 sources"). */
  sourceCount: number;
  /** `notify.yaml: push_min_score`, in the label of the third block. */
  pushLine: number;
}

/**
 * The five summary blocks of Today: label, rolling number, share of what was fetched, change against the previous cycle and the
 * trend of the last cycles (`ui.yaml: trend_cycles`). On a phone only fetched, at-or-above-push-line and salary are left, as one compact row.
 * A block whose step failed in the cycle shows the word "not processed" and what waits, never a 0.
 */
export function KpiStrip({ blocks, cycleLabel, cycleTime, sourceCount, pushLine }: KpiStripProps) {
  const t = useTranslations("dashboard.kpi");
  if (blocks.length === 0) return null;

  return (
    <section className="kpis" aria-label={t("label")} data-testid="kpi-strip">
      {blocks.map((block) => {
        const hero = block.key === "fetched";
        const label = block.key === "qualified" ? t("qualified", { line: pushLine }) : t(block.key);
        const share = hero ? (block.value === null ? null : 100) : block.share;
        const shareText = hero ? t("sources", { count: sourceCount }) : share === null ? `— / ${t("ofFetched")}` : `${formatPercent(share)} / ${t("ofFetched")}`;
        return (
          <div
            key={block.key}
            className={hero ? "kpi kpi--hero" : "kpi"}
            data-k={block.key}
            data-testid={`kpi-${block.key}`}
            data-value={block.value ?? undefined}
            data-pending={block.pending?.reason}
            role="group"
            aria-label={block.pending ? `${label}: ${t(block.pending.reason)}` : label}
            style={hero ? undefined : ({ "--c": BLOCK_VAR[block.key] } as React.CSSProperties)}
          >
            <span className="kpi__l">
              {hero ? <span aria-hidden>●</span> : <i aria-hidden />}
              {hero ? (
                cycleTime && cycleLabel.endsWith(cycleTime) ? (
                  <>
                    <span className="kpi__ll">{cycleLabel.slice(0, cycleLabel.length - cycleTime.length)}</span>
                    {cycleTime}
                  </>
                ) : (
                  cycleLabel
                )
              ) : (
                <span className="kpi__ll">{label}</span>
              )}
              {hero ? <span className="kpi__ll"> · {label}</span> : <span className="kpi__ls">{block.key === "qualified" ? t("qualifiedShort", { line: pushLine }) : t("salaryShort")}</span>}
            </span>
            {block.pending ? (
              <>
                {/* the step behind this count failed: the word, not a fake 0 */}
                <span className="kpi__n kpi__n--pending" data-testid="kpi-pending-word">
                  {t(block.pending.reason)}
                </span>
                <span className="kpi__f">
                  <span className="kpi__one kpi__one--wrap" data-testid="kpi-pending-note">
                    {block.pending.count === null ? t("unprocessedNote") : t("unprocessedCount", { count: block.pending.count, fetched: block.pending.fetched ?? block.pending.count })}
                  </span>
                </span>
              </>
            ) : (
              <>
                <span className="kpi__n">
                  <NumberRoll value={block.value} />
                </span>
                <PercentBar value={share} size="sm" tone={hero ? "ink" : BLOCK_TONE[block.key]} label={shareText} ariaLabel={`${label}: ${shareText}`} />
                <span className="kpi__f">
                  {/* No previous cycle = no change to print (nothing, not a dashed "—" box) */}
                  {block.delta === null ? <span /> : <Delta value={block.delta} />}
                  {/* a trend needs two points: with one cycle the strip says so in words instead of drawing a lone dot */}
                  {block.series.filter((value) => value !== null).length < 2 ? (
                    <span className="kpi__one" data-testid={`kpi-${block.key}-trend-none`}>
                      {t("cycles", { count: block.series.length })}
                    </span>
                  ) : (
                    <Sparkline values={block.series} width={hero ? 150 : 90} height={30} />
                  )}
                </span>
              </>
            )}
          </div>
        );
      })}
    </section>
  );
}
