import { useFormatter, useTranslations } from "next-intl";

import type { InsightsView } from "@/lib/insights/view";

import { CitiesCard, ConversionCard, DailyCard, DisclosureCard, FiltersCard, FunnelCard, PassRateCard, SalaryCard, ScoresCard, SignalsCard, SourcesCard } from "./cards";
import { CardEmpty } from "./insight-card";
import { KpiStrip } from "./kpi-strip";
import { RangeSwitch } from "./range-switch";

/**
 * The whole /insights page body: range switch, headline numbers and the cards (one empty state when the range holds nothing).
 * The headline numbers keep their place in the tree when the range changes, so they roll to the new values; the cards are
 * keyed by the range, so their charts are new elements and replay.
 */
export function InsightsPage({ view, defaultRange }: { view: InsightsView; defaultRange: number }) {
  const t = useTranslations("insights");
  const format = useFormatter();
  const day = (value: string) => format.dateTime(new Date(`${value}T12:00:00Z`), { dateStyle: "medium", timeZone: "UTC" });

  return (
    <div className="flex flex-col gap-4" data-testid="insights" data-range={view.rangeDays}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <RangeSwitch ranges={view.ranges} active={view.rangeDays} defaultRange={defaultRange} />
        <span className="text-ink-2 text-data font-mono" data-testid="insights-window">
          {t("window", { from: day(view.window.from), to: day(view.window.to) })}
        </span>
      </div>
      {view.empty ? (
        <div className="flex flex-col gap-1" data-testid="insights-empty">
          <CardEmpty>
            <span className="text-ink text-body block font-semibold">{t("empty.title", { days: view.rangeDays })}</span>
            {t("empty.hint")}
          </CardEmpty>
        </div>
      ) : (
        <>
          <KpiStrip view={view} />
          <div key={view.rangeDays} className="flex flex-col gap-4" data-testid="insights-cards">
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
              <DailyCard view={view} />
              <ConversionCard view={view} />
            </div>
            <div className="grid gap-4 lg:grid-cols-3">
              <PassRateCard view={view} />
              <DisclosureCard view={view} />
              <SalaryCard view={view} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <SourcesCard view={view} />
              <CitiesCard view={view} />
              <ScoresCard view={view} />
              <SignalsCard view={view} />
              <FunnelCard view={view} />
              <FiltersCard view={view} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
