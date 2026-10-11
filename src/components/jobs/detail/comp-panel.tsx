import { useTranslations } from "next-intl";
import { useAppLocale } from "@/components/viz/intl";

import { signalAmountText } from "@/lib/dashboard/signal-label";
import type { JobLanguage, SignalTier } from "@/lib/db/queries/types";
import type { CategoryView } from "@/lib/signals/catalog";
import { signalColorClasses } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

import { Badge, SignalTag } from "@/components/ui/badge";
import { formatSalary, formatScoreValue } from "@/lib/format/numbers";

import { CapBar } from "./cap-bar";
import { ClampedQuote } from "./clamped-quote";
import { JumpTag } from "./jump-tag";
import { PlaceholderBox } from "./panel";

export interface CompSignal {
  id: number;
  /** Category id. */
  tier: SignalTier;
  kind: string;
  value: unknown;
  /** C7: verbatim JD quote, or the source field's own text when `quoteSource` is `structured`. */
  quote: string;
  /** Default `description`. */
  quoteSource?: "description" | "structured";
  extractor: "rule" | "ai";
  /** An amount below the salary floor: muted, no points. */
  belowFloor?: boolean;
  /** An amount that is possibly another region's pay, and why; null / absent = local. */
  otherRegion?: "currency" | "description" | null;
  /** Where the term that makes the quote a signal stands in the quote (kept in sight when the quote is shortened). */
  term?: { start: number; end: number } | null;
  /** Position of the quote in the JD panel's quote list (its mark id); with `inJd` the tag jumps to the sentence. */
  quoteIndex?: number;
  /** The JD text shows this quote highlighted. Without it there is nothing to jump to and the tag is plain (C7: the quote is still shown). */
  inJd?: boolean;
}

export interface CompBonus {
  /** The categories that count, each once, in category order (`signalBonus`). */
  categories: Array<{ id: string; points: number }>;
  sum: number;
  bonus: number;
  cap: number;
  capped: boolean;
  /** The job states an amount but none reaches the high-pay minimum. */
  amountBelowThreshold?: boolean;
  /** The base currency `amountMinAnnualEur` is in ("" = unknown). */
  baseCurrency?: string | null;
  /** Per year in the base currency a stated amount needs to count; null = none. */
  amountMinAnnualEur?: number | null;
  /** Every high-pay amount is possibly another region's pay: the amount category brings reduced points (maybe none). */
  amountOtherRegion?: boolean;
}

export interface CompPanelProps {
  /** The salary the channel stated (jobs.salary_json), already described for display; null when none. */
  salary: { normalized: string | null; /** The EUR figure of another currency ("≈ €139–163k /年"). */ eurApprox?: string | null; raw: string | null; periodAssumed: boolean; otherRegion?: { reason: "currency" | "description"; currency: string | null } | null; includesVariable?: boolean } | null;
  /** `salary_json` exists but could not be read. */
  salaryDisclosed: boolean;
  /** Signals of the active categories (the page leaves the others out), in category order. */
  signals: readonly CompSignal[];
  /** The active signal categories, in order. */
  categories: readonly CategoryView[];
  bonus: CompBonus;
  /** What the signals step did for this job; null before its first scan. */
  scan: { aiReviewed: boolean } | null;
  language: JobLanguage;
}

/**
 * "Pay and benefits" of the detail page (mockup `.sig-list`): the salary the posting states, then
 * every signal with its tier, the normalized amount, the points it brings and the verbatim JD
 * quote; the capped bonus total; the benefit tags (no points).
 */
/** A signal's tag in the narrow first column: a long name wraps inside the tag instead of running into the amount beside it. */
const TAG_WRAP = "max-w-full justify-start text-left whitespace-normal [overflow-wrap:anywhere]";

export function CompPanel({ salary, salaryDisclosed, signals, categories, bonus, scan, language }: CompPanelProps) {
  const t = useTranslations("dashboard.detail");
  const ts = useTranslations("signals.comp");
  const locale = useAppLocale();
  const known = language === "en" || language === "de";

  const byId = new Map(categories.map((category) => [category.id, category]));
  const amountCategory = categories.find((category) => category.kind === "amount") ?? null;
  const shown = signals.filter((s) => byId.has(s.tier));
  const paying = shown.filter((s) => byId.get(s.tier)?.kind !== "tag");
  const tags = shown.filter((s) => byId.get(s.tier)?.kind === "tag");
  const counted = new Set<SignalTier>();
  const minText = bonus.amountMinAnnualEur == null ? "" : (formatSalary({ min: bonus.amountMinAnnualEur, max: bonus.amountMinAnnualEur, currency: bonus.baseCurrency ?? "" }, { locale }) ?? "");
  // the JD itself states an amount: the "not disclosed" box would contradict it
  const hasAmountSignal = amountCategory !== null && paying.some((s) => s.tier === amountCategory.id);
  const amountPoints = amountCategory ? (bonus.categories.find((b) => b.id === amountCategory.id)?.points ?? 0) : 0;
  const amountName = amountCategory?.label ?? "";

  return (
    <div className="flex flex-col gap-3" data-testid="comp-panel">
      {salary ? (
        <div className="flex flex-col gap-1" data-testid="salary-block">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-muted-foreground text-xs">{t("comp.normalized")}</span>
            <span className="font-mono text-base leading-snug font-medium tabular-nums" data-testid="salary-normalized">
              {salary.normalized ?? t("comp.unreadable")}
            </span>
            {salary.eurApprox ? (
              <span className="text-ink-2 font-mono text-base leading-snug tabular-nums" data-testid="salary-eur-approx">
                {salary.eurApprox}
              </span>
            ) : null}
          </div>
          {salary.periodAssumed ? <p className="text-muted-foreground text-xs">{t("comp.periodAssumed")}</p> : null}
          {salary.includesVariable ? (
            <p className="text-muted-foreground text-xs" data-testid="salary-variable">
              {ts("includesVariable")}
            </p>
          ) : null}
          {salary.otherRegion ? (
            <p className="text-muted-foreground text-xs" data-testid="salary-other-region">
              {salary.otherRegion.reason === "currency" ? ts("otherRegionCurrency", { currency: salary.otherRegion.currency ?? "" }) : ts("otherRegionDescription")}
            </p>
          ) : null}
          {salary.raw ? (
            <ClampedQuote
              text={salary.raw}
              term={null}
              color={amountCategory?.color ?? "neutral"}
              label={t("comp.original")}
              testId="salary-raw"
              className="border-border"
              expandLabel={ts("expand")}
              collapseLabel={ts("collapse")}
            />
          ) : null}
        </div>
      ) : salaryDisclosed ? (
        <PlaceholderBox testId="salary-unreadable">{t("comp.unreadable")}</PlaceholderBox>
      ) : hasAmountSignal ? null : (
        <PlaceholderBox testId="salary-unknown">— {t("comp.none")}</PlaceholderBox>
      )}

      {paying.length > 0 ? (
        <ul className="flex flex-col gap-3" data-testid="signal-list">
          {paying.map((signal) => {
            const category = byId.get(signal.tier);
            if (!category) return null;
            const isAmount = category.kind === "amount";
            const colors = signalColorClasses(category.color);
            // an amount of another region only counts when no local amount does (and other_region_weight gives it points)
            const otherRegionMuted = signal.otherRegion != null && !(bonus.amountOtherRegion === true && bonus.categories.some((b) => b.id === signal.tier));
            const muted = signal.belowFloor === true || otherRegionMuted;
            const first = !muted && !counted.has(signal.tier);
            if (!muted) counted.add(signal.tier);
            const points = bonus.categories.find((b) => b.id === signal.tier)?.points ?? 0;
            const currency = signal.value && typeof signal.value === "object" && "currency" in signal.value ? String(signal.value.currency) : "";
            const amount = isAmount ? signalAmountText(signal.value, locale) : null;
            const tierName = category.label;
            const jump = signal.inJd === true && signal.quoteIndex !== undefined ? signal.quoteIndex : null;
            const mark = category.code ?? category.icon;
            const tagLook = muted ? (
              <Badge variant="skill-miss" className={cn("shadow-none", TAG_WRAP)}>
                {mark ? <b className="font-mono font-bold">{mark}</b> : null} {tierName}
              </Badge>
            ) : isAmount ? (
              <Badge className={cn(colors.solid, "shadow-e1", TAG_WRAP)}>
                {mark ? <b className="font-mono font-bold">{mark}</b> : null} {tierName}
              </Badge>
            ) : (
              <SignalTag className={TAG_WRAP} code={category.code} icon={category.icon} color={category.color}>
                {tierName}
              </SignalTag>
            );
            // `data-slot="signal-badge"` / `data-muted`: the hook the page has always had for "this signal brings no points"
            const tag = (
              <span data-slot="signal-badge" data-tier={signal.tier} data-muted={muted ? "true" : undefined} className="contents">
                {tagLook}
              </span>
            );
            return (
              <li key={signal.id} className="border-grid grid gap-x-3 gap-y-2 border-t-[1.5px] py-2.5 first:border-t-0 first:pt-0 md:grid-cols-[9.5rem_minmax(0,1fr)_auto]" data-testid="signal-item" data-tier={signal.tier} data-in-jd={jump !== null}>
                <div className="flex min-w-0 flex-wrap items-start gap-1.5 md:flex-col">
                  {jump !== null ? (
                    <JumpTag index={jump} label={ts("jump", { name: tierName })}>
                      {tag}
                    </JumpTag>
                  ) : (
                    tag
                  )}
                </div>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {amount ? <span className="text-muted-foreground text-xs">{ts("normalized")}</span> : null}
                    <span className="font-mono text-base leading-snug font-medium tabular-nums [overflow-wrap:anywhere]" data-testid="signal-value">
                      {amount ? amount.normalized : tierName}
                    </span>
                    <span className="text-muted-foreground text-[13px] tabular-nums" data-testid="signal-points">
                      {signal.belowFloor === true ? ts("belowFloor", { min: minText }) : muted ? ts("otherRegionNoPoints") : first ? ts("points", { n: points }) : ts("pointsCounted")}
                    </span>
                  </div>
                  {amount ? (
                    <ul className="text-muted-foreground mt-0.5 text-xs">
                      {amount.stated ? <li>{ts("statedAs", { amount: amount.stated })}</li> : null}
                      {amount.eurApprox ? <li className="font-mono tabular-nums">{amount.eurApprox}</li> : null}
                      {amount.periodAssumed ? <li>{ts("periodAssumed")}</li> : null}
                      {amount.currencyAssumed ? <li>{ts("currencyAssumed", { currency })}</li> : null}
                      {signal.otherRegion ? (
                        <li data-testid="signal-other-region">{signal.otherRegion === "currency" ? ts("otherRegionCurrency", { currency }) : ts("otherRegionDescription")}</li>
                      ) : null}
                    </ul>
                  ) : null}
                  <ClampedQuote
                    text={signal.quote}
                    term={signal.term ?? null}
                    color={category.color}
                    lang={known ? language : undefined}
                    className={colors.quoteBorder}
                    expandLabel={ts("expand")}
                    collapseLabel={ts("collapse")}
                  />
                  <div className="text-muted-foreground text-data-sm mt-1 font-mono">{signal.quoteSource === "structured" ? ts("foundByStructured") : ts("foundBy", { who: ts(`extractor.${signal.extractor}`) })}</div>
                </div>
                <b aria-hidden className={cn("font-display text-num-s max-md:hidden md:text-right", !first && "text-ink-3")}>
                  {first ? `+${formatScoreValue(points)}` : "—"}
                </b>
              </li>
            );
          })}
        </ul>
      ) : scan === null ? (
        <PlaceholderBox testId="signals-pending">{ts("pending")}</PlaceholderBox>
      ) : (
        <PlaceholderBox testId="signals-none">— {ts("none")}</PlaceholderBox>
      )}

      {paying.length > 0 ? (
        <div className="flex flex-col gap-2">
          {bonus.categories.length === 0 ? (
            <p className="text-muted-foreground text-[13px]" data-testid="bonus-line">
              <span className="text-foreground font-medium">{ts("bonusTitle")}</span>: {ts("noBonus")}
            </p>
          ) : null}
          {bonus.amountBelowThreshold ? (
            <p className="text-muted-foreground text-[13px]" data-testid="below-floor-note">
              {ts("belowFloorNote", { min: minText, name: amountName })}
            </p>
          ) : null}
          {bonus.amountOtherRegion ? (
            <p className="text-muted-foreground text-[13px]" data-testid="other-region-note">
              {ts("otherRegionNote", { points: amountPoints, name: amountName })}
            </p>
          ) : null}
          {bonus.categories.length > 0 ? (
            <CapBar
              tiers={bonus.categories.map((entry) => {
                const category = byId.get(entry.id);
                return { id: entry.id, points: entry.points, color: category?.color ?? "neutral", code: category?.code ?? null, label: category?.label ?? entry.id };
              })}
              cap={bonus.cap}
            />
          ) : null}
        </div>
      ) : null}

      {tags.length > 0 ? (
        <div className="border-border border-t-bw pt-3" data-testid="benefit-tags">
          <div className="text-muted-foreground mb-2 text-xs">{ts("benefits")}</div>
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((tag) => {
              const chip = (
                <Badge variant="tag" title={`“${tag.quote}”`} className="text-data font-semibold">
                  <b aria-hidden>+</b> {tag.kind}
                </Badge>
              );
              return (
                <li key={tag.id} data-in-jd={tag.inJd === true}>
                  {tag.inJd === true && tag.quoteIndex !== undefined ? (
                    <JumpTag index={tag.quoteIndex} label={ts("jump", { name: tag.kind })}>
                      {chip}
                    </JumpTag>
                  ) : (
                    chip
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {scan !== null ? (
        <p className="text-muted-foreground text-xs" data-testid="signal-scan-state">
          {scan.aiReviewed ? ts("aiDone") : ts("aiPending")}
        </p>
      ) : null}
    </div>
  );
}
