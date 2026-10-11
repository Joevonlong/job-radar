import { useFormatter, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { CatalogProviderView } from "@/lib/settings/catalog-view";
import { cn } from "@/lib/utils";

/**
 * The read-only catalog of one provider: id, name, price, reasoning efforts (codex), flags, notes.
 * A table on desktop; on phones every model is a stacked block with its own labels (no sideways scroll).
 * `label` / `notes` are what the user wrote in models.yaml and are shown as they are (not translated).
 */
export function ModelCatalogTable({ provider, selected, showEfforts, file }: { provider: CatalogProviderView; selected: readonly string[]; showEfforts: boolean; file: string }) {
  const t = useTranslations("settings.catalog");
  const format = useFormatter();
  const cell = "py-1.5 pr-3 max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:py-0.5 max-sm:before:text-ink-2 max-sm:before:shrink-0 max-sm:before:content-[attr(data-label)]";
  const num = (value: number): string => format.number(value, { maximumFractionDigits: 4 });
  return (
    <div className="flex flex-col gap-2" data-testid={`model-catalog-${provider.id}`}>
      <h4 className="text-label font-bold [overflow-wrap:anywhere]">{t("title", { file })}</h4>
      <div role="region" tabIndex={0} aria-label={t("tableLabel", { provider: provider.id })} className="overflow-x-auto">
        <table className="w-full text-body-sm max-sm:block" aria-label={t("tableLabel", { provider: provider.id })}>
          <thead className="max-sm:sr-only">
            <tr className="text-cap-style text-ink-2 bg-soft border-border border-b-bw text-left">
              <th scope="col" className="px-2 py-1.5 font-medium">{t("col.model")}</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.label")}</th>
              <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.price")}</th>
              {showEfforts ? <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.efforts")}</th> : null}
              <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.flags")}</th>
              <th scope="col" className="py-1.5 pr-2 font-medium">{t("col.notes")}</th>
            </tr>
          </thead>
          <tbody className="max-sm:flex max-sm:flex-col">
            {provider.models.map((model) => (
              <tr key={model.id} className="border-grid border-b-[1.5px] align-top last:border-b-0 max-sm:block max-sm:py-2" data-testid="catalog-row" data-model={model.id}>
                <td className={cn(cell, "px-2 font-mono text-data break-all max-sm:px-0 max-sm:font-bold")}>{model.id}</td>
                <td className={cell} data-label={t("col.label")}>{model.label ?? ""}</td>
                <td className={cn(cell, "font-mono tabular-nums sm:whitespace-nowrap max-sm:text-right")} data-label={t("col.price")} {...(model.equivalentPrice ? { title: model.equivalentPrice.source } : {})}>
                  {model.price
                    ? `$${num(model.price.input)} / $${num(model.price.output)}`
                    : model.equivalentPrice
                      ? t("subscriptionEquivalent", { input: num(model.equivalentPrice.input), output: num(model.equivalentPrice.output) })
                      : t("subscription")}
                </td>
                {showEfforts ? (
                  <td className={cn(cell, "font-mono text-data")} data-label={t("col.efforts")}>
                    {model.efforts ? model.efforts.join(", ") : t("allEfforts")}
                  </td>
                ) : null}
                <td className={cell} data-label={t("col.flags")}>
                  <span className="flex flex-wrap gap-1 max-sm:justify-end">
                    {selected.includes(model.id) ? <Badge variant="skill-hit">{t("flag.selected")}</Badge> : null}
                    {model.cliDefault ? <Badge variant="skill">{t("flag.cliDefault")}</Badge> : null}
                    {model.deprecated ? <Badge variant="gate-note">{t("flag.deprecated")}</Badge> : null}
                  </span>
                </td>
                <td className={cn(cell, "pr-2 max-sm:pr-0")} data-label={t("col.notes")}>
                  <span className="max-sm:text-right">{model.notes ?? ""}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-ink-2 text-body-sm [overflow-wrap:anywhere]">
        {t("hint", { file })}
        {provider.docsUrl ? (
          <>
            {" "}
            <a href={provider.docsUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">
              {t("docs")} ↗
            </a>
          </>
        ) : null}
      </p>
    </div>
  );
}
