import { getFormatter, getTranslations } from "next-intl/server";

import { TriggerButton } from "@/components/control/trigger-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Battery } from "@/components/viz";
import type { SourcesView } from "@/lib/sources/view";
import { cn } from "@/lib/utils";

import { formatWhen } from "./format";

/** Per AI provider the switch, today's requests against the cap, the last success / error and a running cooldown. */
export async function AiHealthCard({ providers, timeZone, alertPercent }: { providers: SourcesView["ai"]["providers"]; timeZone: string; alertPercent: number }) {
  const [t, format] = await Promise.all([getTranslations("sources.aiHealth"), getFormatter()]);
  if (providers.length === 0) return null;
  return (
    <Card className="gap-0 py-0" data-testid="ai-health-card">
      <CardHeader className="px-4 py-3">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="px-4 py-3.5">
        {/* desktop: a table; phones: every provider is a stacked block with its own labels (no sideways scroll, the Test button stays reachable) */}
        <div role="region" tabIndex={0} aria-label={t("title")} className="overflow-x-auto">
          <table className="w-full text-body-sm max-sm:block">
            <thead className="max-sm:sr-only">
              <tr className="text-cap-style text-ink-2 border-border border-b-bw text-left">
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.provider")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.state")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.today")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.lastSuccess")}</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">{t("col.lastError")}</th>
                <th scope="col" className="py-1.5 font-medium">
                  <span className="sr-only">{t("col.test")}</span>
                </th>
              </tr>
            </thead>
            <tbody className="max-sm:flex max-sm:flex-col">
              {providers.map((p) => {
                const { state } = p;
                const cell = "py-1.5 pr-3 max-sm:flex max-sm:items-baseline max-sm:justify-between max-sm:gap-3 max-sm:pr-0 max-sm:py-0.5 max-sm:before:text-ink-2 max-sm:before:shrink-0 max-sm:before:content-[attr(data-label)]";
                return (
                  <tr key={p.id} className="border-grid border-b-[1.5px] align-top last:border-b-0 max-sm:block max-sm:py-2" data-testid="ai-health-row" data-provider={p.id} data-state={state}>
                    <td className={cn(cell, "max-sm:flex-col max-sm:items-start max-sm:gap-0")}>
                      <span className="flex flex-col gap-0.5">
                        <span className="font-mono text-data font-bold">{p.id}</span>
                        <span className="text-ink-2 flex flex-wrap items-center gap-1 text-body-sm" data-testid="ai-model" data-status={p.model.status}>
                          {p.model.status === "cliDefault" ? (
                            <span>{p.model.label ? `${t("cliDefault")} · ${p.model.label}` : t("cliDefault")}</span>
                          ) : (
                            <span className="font-mono text-data">{p.model.label ? `${p.model.label} · ${p.model.id}` : p.model.id}</span>
                          )}
                          {p.model.status === "deprecated" ? <Badge variant="gate-note">{t("modelDeprecated")}</Badge> : null}
                          {p.model.status === "missing" ? <Badge variant="gate-warn">{t("modelMissing")}</Badge> : null}
                        </span>
                      </span>
                    </td>
                    <td className={cell} data-label={t("col.state")}>
                      <span className="max-sm:text-right">
                        {state === "cooling" && p.coolingUntil
                          ? t("state.cooling", { until: formatWhen(format, p.coolingUntil, timeZone) })
                          : state === "guarded" && p.guardedUntil
                            ? t("state.guarded", { until: formatWhen(format, p.guardedUntil, timeZone) })
                            : t(`state.${state}`)}
                      </span>
                    </td>
                    <td className={cn(cell, "font-mono tabular-nums")} data-label={t("col.today")} data-testid="ai-today">
                      <span className="flex flex-col gap-1 whitespace-nowrap max-sm:items-end">
                        <span>{p.dailyCap > 0 ? `${format.number(p.requestsToday)} / ${format.number(p.dailyCap)}` : t("unlimited", { count: format.number(p.requestsToday) })}</span>
                        {p.dailyCap > 0 ? <Battery value={(p.requestsToday / p.dailyCap) * 100} threshold={alertPercent} ariaLabel={`${t("col.today")}: ${p.id}`} /> : null}
                        {/* Job Radar's own usage cap of a subscription CLI: its calls in the rolling window */}
                        {p.quota ? (
                          <span className="mt-1 flex flex-col gap-1 max-sm:items-end" data-testid="ai-quota-window" data-level={p.quota.level}>
                            <span className="text-ink-2">
                              {p.quota.hardRequests > 0
                                ? t("window", { hours: format.number(p.quota.windowHours), used: format.number(p.quota.windowRequests), cap: format.number(p.quota.hardRequests) })
                                : t("windowOff", { hours: format.number(p.quota.windowHours), used: format.number(p.quota.windowRequests) })}
                            </span>
                            {p.quota.hardRequests > 0 ? (
                              <Battery
                                value={(p.quota.windowRequests / p.quota.hardRequests) * 100}
                                threshold={alertPercent}
                                ariaLabel={t("windowLabel", { hours: format.number(p.quota.windowHours), provider: p.id })}
                              />
                            ) : null}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className={cn(cell, "whitespace-nowrap")} data-label={t("col.lastSuccess")}>{p.lastSuccessAt ? formatWhen(format, p.lastSuccessAt, timeZone) : t("never")}</td>
                    <td className={cell} data-label={t("col.lastError")}>
                      {p.lastErrorAt ? (
                        <span title={p.lastErrorMessage ?? undefined} className="max-sm:text-right">
                          {formatWhen(format, p.lastErrorAt, timeZone)} · <span className="font-mono text-data">{p.lastErrorKind}</span>
                        </span>
                      ) : (
                        <span className="text-ink-2">{t("none")}</span>
                      )}
                    </td>
                    <td className="max-w-64 py-1.5 max-sm:block max-sm:max-w-none max-sm:pt-2">
                      {/* A probe call on the ai-worker; off while the provider cannot run (the router would refuse it anyway) */}
                      <TriggerButton kind="testAi" target={p.id} disabled={state === "unconfigured" || state === "off" || state === "capped" || state === "cooling" || state === "guarded"} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {providers.some((p) => p.quota !== null) ? (
          <p className="text-ink-2 mt-2 text-body-sm" data-testid="ai-quota-note">
            {t("quotaNote")}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
