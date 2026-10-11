"use client";

import { useTranslations } from "next-intl";

import { Led, NumberRoll } from "@/components/viz";
import { REGISTRY_STATUSES, registryTone, type RegistryStatus } from "@/lib/sources/registry/status";
import { cn } from "@/lib/utils";

/** Seven counters, one per state. A click shows only that state (a second click clears it); they drive the state filter below. */
export function StatusSummary({ counts, selected, onToggle }: { counts: Record<RegistryStatus, number>; selected: readonly RegistryStatus[]; onToggle: (status: RegistryStatus) => void }) {
  const t = useTranslations("sourcesRegistry");
  return (
    <div role="group" aria-label={t("summary.label")} className="grid grid-cols-3 gap-3 xl:grid-cols-7" data-testid="registry-summary">
      {REGISTRY_STATUSES.map((status) => {
        const on = selected.length === 1 && selected[0] === status;
        return (
          <button
            key={status}
            type="button"
            aria-pressed={on}
            onClick={() => onToggle(status)}
            data-testid={`summary-${status}`}
            data-count={counts[status]}
            className={cn(
              "rounded-card border-bw border-border bg-card shadow-e1 flex min-w-0 cursor-pointer flex-col items-start gap-1 px-3 py-2.5 text-left transition-colors duration-fast hover:bg-soft",
              "aria-pressed:bg-hi aria-pressed:text-hi-ink aria-pressed:shadow-none",
            )}
          >
            <span className="flex items-center gap-1.5 font-mono text-data font-semibold tracking-[0.04em] uppercase">
              <Led tone={registryTone(status)} label={false} />
              {t(`status.${status}`)}
            </span>
            <span className="font-display text-num-m">
              <NumberRoll value={counts[status]} />
            </span>
          </button>
        );
      })}
    </div>
  );
}
