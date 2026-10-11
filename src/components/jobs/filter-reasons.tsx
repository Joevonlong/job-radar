import { useTranslations } from "next-intl";
import { useAppLocale } from "@/components/viz/intl";

import { knownContract } from "@/lib/dashboard/labels";
import { isNoteReason, orderedReasons, parseFilterReason } from "@/lib/filter/reasons";
import { formatSalary } from "@/lib/format/numbers";

const WORKPLACES = ["onsite", "hybrid", "remote", "unknown"] as const;

/**
 * Localized text of the hard-filter reasons (`scores.filter_reasons`). A reason that is not one of
 * the codes (older rows) is shown as it is. Works in server and client components.
 */
export function useFilterReasonText(options: { floorAtFilter?: number | null; currency?: string; dealBreakerLabels?: Readonly<Record<string, string>> } = {}): (raw: string) => string {
  const t = useTranslations("filter.reasons");
  const tDash = useTranslations("dashboard");
  const locale = useAppLocale();
  const money = (amount: number): string => formatSalary({ min: amount, max: amount, currency: options.currency ?? "" }, { locale }) ?? String(amount);

  return (raw) => {
    const { code, detail } = parseFilterReason(raw);
    if (code === null) return raw;
    let shown = detail ?? "";
    if (code === "salary_below_floor") {
      const amount = Number(detail);
      if (Number.isFinite(amount)) shown = money(amount);
      // the floor the filter used then (when the snapshot it ran under says so): "cap €70k was below your floor of €80k at the time"
      if (options.floorAtFilter != null) return t("salary_below_floor_at", { detail: shown, floor: money(options.floorAtFilter) });
    } else if (code === "contract_excluded" || code === "contract_not_allowed") {
      const kind = knownContract(shown);
      if (kind) shown = tDash(`contract.${kind}`);
    } else if (code === "deal_breaker") {
      // the rule's name as it is now; a rule deleted since is shown by its id
      shown = (detail !== null ? options.dealBreakerLabels?.[detail] : undefined) ?? shown;
    } else if (code === "workplace_not_wanted") {
      const place = WORKPLACES.find((w) => w === shown);
      if (place) shown = tDash(`workplace.${place}`);
    }
    return t(code, { detail: shown });
  };
}

/** The salary floor of `preferences.yaml` as the hard filter used it for a job, and as it is now (null = unknown / none). */
export interface FloorContext {
  atFilter: number | null;
  current: number | null;
  /** The market's base currency the floor is in. */
  currency?: string;
}

/** The salary-floor reason of a filtered job was made under another floor than the current one: "底线已改为 70k，下一轮重新过滤". */
export function floorChanged(reasons: readonly string[], floor: FloorContext | undefined): floor is FloorContext & { current: number } {
  if (!floor || floor.current === null) return false;
  const reason = reasons.find((r) => parseFilterReason(r).code === "salary_below_floor");
  if (reason === undefined) return false;
  if (floor.atFilter !== null) return floor.atFilter !== floor.current;
  const cap = Number(parseFilterReason(reason).detail);
  return Number.isFinite(cap) && cap >= floor.current; // the snapshot is gone, but the cap now clears the floor
}

/** "底线已改为 €70k，下一轮重新过滤。": said after the reasons whenever the floor has changed since the filter ran (detail page and lists). */
export function FloorChangedText({ floor, currency = "" }: { floor: number; currency?: string }) {
  const t = useTranslations("filter");
  const locale = useAppLocale();
  return <b data-testid="filter-floor-changed">{t("floorChanged", { floor: formatSalary({ min: floor, max: floor, currency }, { locale }) ?? String(floor) })}</b>;
}

/**
 * The reasons of a filtered job as one line of text. With `floor` a salary reason names the floor used at filter time and, when the
 * floor has changed since, says so: the one wording of the list and of the detail page.
 */
export function FilterReasonText({ reasons, fallback, floor, dealBreakerLabels }: { reasons: readonly string[]; fallback?: string; floor?: FloorContext; dealBreakerLabels?: Readonly<Record<string, string>> }) {
  const text = useFilterReasonText({ floorAtFilter: floor?.atFilter ?? null, ...(floor?.currency !== undefined ? { currency: floor.currency } : {}), ...(dealBreakerLabels ? { dealBreakerLabels } : {}) });
  const excluding = orderedReasons(reasons.filter((r) => !isNoteReason(r)));
  const list = excluding.length > 0 ? excluding : reasons;
  return (
    <>
      {list.length > 0 ? list.map(text).join("; ") : (fallback ?? "")}
      {floorChanged(list, floor) ? (
        <>
          {" "}
          <FloorChangedText floor={floor.current} currency={floor.currency ?? ""} />
        </>
      ) : null}
    </>
  );
}
