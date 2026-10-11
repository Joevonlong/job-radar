import { useLocale, useTranslations } from "next-intl";

import { useLocalLanguageName } from "@/components/base-currency";
import { signalAmountLabel } from "@/lib/dashboard/signal-label";
import { isGermanRequirement } from "@/lib/domain/types";

import { FactBadge, SignalBadge, UnknownBadge } from "./signal-badge";
import { TrapBadge } from "./trap-badge";
import { VisaBadge } from "./visa-badge";
import type { JobListItem } from "./types";

/** An amount that is not a local high-pay signal (below the floor, or possibly another region's pay): muted. */
export const isMutedT1 = (signal: JobListItem["signals"][number]): boolean => signal.belowFloor === true || signal.otherRegion === true;

/** Contract kinds that deserve a badge of their own (`permanent` is the default, `unknown` never gets one, C3). */
const CONTRACT_BADGES = ["freelance", "student", "fixed_term"] as const;

/**
 * Badges of a job row: signals (one per category, in category order; tag categories are detail-page material), the stated salary (always "💰 annual range") or a dashed "not disclosed", the
 * German requirement when the posting states one, agency, and the notable contract kinds.
 */
export function JobBadges({ job }: { job: JobListItem }) {
  const t = useTranslations("dashboard");
  const ts = useTranslations("signals.comp");
  const locale = useLocale();
  const languageName = useLocalLanguageName();

  // one badge per category (a job can carry several quotes of one); the signals come in category order
  const minAnnualEur = job.amountMinAnnualEur ?? null;
  const floorText = minAnnualEur === null ? "" : job.amountCurrency ? new Intl.NumberFormat(locale, { style: "currency", currency: job.amountCurrency, maximumFractionDigits: 0 }).format(minAnnualEur) : new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(minAnnualEur);
  const signals = job.signals
    .filter((s) => s.category.kind !== "tag")
    // an amount that is high-pay wins over one below the floor (stable sort: the category order stays)
    .map((s, index) => ({ s, index }))
    .sort((a, b) => (a.s.tier === b.s.tier ? Number(isMutedT1(a.s)) - Number(isMutedT1(b.s)) : a.index - b.index))
    .map(({ s }) => s)
    .filter((s, index, all) => all.findIndex((other) => other.tier === s.tier) === index);
  const hasAmountSignal = signals.some((s) => s.category.kind === "amount");
  const contractBadge = CONTRACT_BADGES.find((c) => c === job.contract);
  // `none` = German is not needed, `unknown` = the posting does not say: neither is a requirement to flag
  const germanRequired = languageName !== null && isGermanRequirement(job.germanLevelRequired);

  return (
    <div className="flex flex-wrap gap-1.5" data-slot="job-badges">
      {/* An AI trap comes first, before the pay signals */}
      {job.trapCount && job.trapCount > 0 ? <TrapBadge count={job.trapCount} /> : null}
      {job.visa ? <VisaBadge visa={job.visa} /> : null}
      {signals.map((signal, index) => {
        // the stated salary (normalized, EUR per year) is the one compensation text of a row; the amount signal only fills in when the job has no usable salary
        const label = (signal.category.kind === "amount" ? (job.salaryText ?? signalAmountLabel(signal.value, locale)) : null) ?? signal.category.label;
        const otherRegion = signal.otherRegion === true && signal.belowFloor !== true;
        return (
          <SignalBadge
            key={`${signal.tier}-${signal.kind}-${index}`}
            tier={signal.tier}
            color={signal.category.color}
            icon={signal.category.icon}
            muted={isMutedT1(signal)}
            title={signal.belowFloor === true ? ts("belowFloorBadge", { min: floorText }) : otherRegion ? ts("otherRegionBadge") : signal.category.label}
          >
            {label}
            {otherRegion ? <span data-testid="other-region-mark"> · {ts("otherRegionShort")}</span> : null}
          </SignalBadge>
        );
      })}
      {!hasAmountSignal && job.salaryText ? (
        <FactBadge tone="accent" title={t("badge.salaryTitle")}>
          <span aria-hidden>💰</span>
          {job.salaryText}
        </FactBadge>
      ) : null}
      {!hasAmountSignal && !job.salaryDisclosed ? <UnknownBadge>— {t("badge.salaryUnknown")}</UnknownBadge> : null}
      {germanRequired ? <FactBadge>{t("badge.german", { level: job.germanLevelRequired, language: languageName ?? "" })}</FactBadge> : null}
      {job.isAgency ? <FactBadge tone="accent">{t("badge.agency")}</FactBadge> : null}
      {contractBadge ? <FactBadge tone="accent">{t(`badge.${contractBadge}`)}</FactBadge> : null}
    </div>
  );
}
