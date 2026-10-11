import { Battery } from "@/components/viz";

interface UsageBarProps {
  value: number;
  max: number;
  /** Accessible name of the battery. */
  label: string;
  /** Text shown next to the label, e.g. "$1.20 / $5.00". */
  valueText: string;
  /** Percent of `max` at which the battery turns red (`notify.yaml: alerts.budget_thresholds`; SourcesView.budgetAlertPercent). */
  threshold: number;
  testId?: string;
}

/** A labelled battery for a used-up-of-limit figure. `max` of 0 renders as full (nothing may be used). Display only: nothing is enforced here. */
export function UsageBar({ value, max, label, valueText, threshold, testId }: UsageBarProps) {
  const ratio = max > 0 ? value / max : value > 0 ? 1 : 0;
  return (
    <div className="flex flex-col gap-1" data-testid={testId} data-ratio={String(Math.round(ratio * 1000) / 1000)}>
      <div className="flex flex-col gap-0.5 text-data">
        <span className="text-ink-2 [overflow-wrap:anywhere]">{label}</span>
        <span className="font-mono tabular-nums">{valueText}</span>
      </div>
      <Battery value={ratio * 100} threshold={threshold} ariaLabel={label} />
    </div>
  );
}
