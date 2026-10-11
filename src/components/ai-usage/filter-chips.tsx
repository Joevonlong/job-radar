import Link from "next/link";
import { useTranslations } from "next-intl";

import { aiUsageHref, type AiUsageUrlState } from "@/lib/ai-usage/params";

import { taskLabel } from "./labels";

const chip = "bg-hi text-hi-ink border-border rounded-tag inline-flex h-7 items-center gap-1.5 border-bw px-2 text-body-sm font-bold hover:bg-[color-mix(in_srgb,var(--hi)_85%,var(--ink))]";

/** The filters a click on a table row set; every chip is a link that drops its own parameter. Renders nothing without filters. */
export function FilterChips({ state }: { state: AiUsageUrlState }) {
  const t = useTranslations("aiUsage.filter");
  const tTask = useTranslations("sources.ai");
  const items: { key: "provider" | "model" | "task"; value: string; text: string }[] = [];
  if (state.provider !== null) items.push({ key: "provider", value: state.provider, text: t("provider", { value: state.provider }) });
  if (state.model !== null) items.push({ key: "model", value: state.model, text: t("model", { value: state.model }) });
  if (state.task !== null) items.push({ key: "task", value: state.task, text: t("task", { value: taskLabel(tTask, state.task) }) });
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label={t("label")} data-testid="ai-usage-filters">
      {items.map((item) => (
        <Link
          key={item.key}
          href={aiUsageHref(state, { [item.key]: null, page: null })}
          className={chip}
          aria-label={t("remove", { name: item.text })}
          data-testid="ai-usage-filter"
          data-filter={item.key}
          data-value={item.value}
        >
          <span className="font-mono">{item.text}</span>
          <span aria-hidden>✕</span>
        </Link>
      ))}
      {items.length > 1 ? (
        <Link href={aiUsageHref(state, { provider: null, model: null, task: null, page: null })} className="text-ink-2 text-body-sm font-bold underline underline-offset-4" data-testid="ai-usage-filters-clear">
          {t("clear")}
        </Link>
      ) : null}
    </div>
  );
}
