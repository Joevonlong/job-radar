import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Battery } from "@/components/viz";
import type { CascadeEntry, SourcesView } from "@/lib/sources/view";

import "./sources.css";
import { RotationStatusLine } from "./rotation-status";
import { EnabledBadge } from "./enabled-badge";
import { formatUsd } from "./format";

type StepState = "on" | "ko" | "standby";

function stepState(entry: CascadeEntry, served: boolean): StepState {
  if (served) return "on";
  if (entry.circuit === "open") return "ko";
  return "standby";
}

/** The LinkedIn cascade as a chain: the step that served the latest cycle is yellow, a tripped step is dashed, every step shows its quota. */
export async function CascadeCard({ cascade, hasCycle, alertPercent }: { cascade: SourcesView["cascade"]; hasCycle: boolean; alertPercent: number }) {
  const [t, tCard, tBudget, format] = await Promise.all([getTranslations("sources.cascade"), getTranslations("sources.card"), getTranslations("sources.budget"), getFormatter()]);
  const anyLatest = cascade.entries.some((e) => e.latest !== null);
  return (
    <Card className="gap-0" data-testid="cascade-card" data-served-by={cascade.servedBy.join(",")}>
      <CardHeader className="px-4 py-3">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="gap-4 px-4 py-5">
        {cascade.rotation ? await RotationStatusLine({ rotation: cascade.rotation, cascade: true }) : null}
        <ol className="src-chain">
          {cascade.entries.map((entry) => {
            const served = cascade.servedBy.includes(entry.id);
            const state = stepState(entry, served);
            const quota = entry.quota;
            return (
              <li key={entry.id} data-testid="cascade-entry" data-channel={entry.id} data-served={served ? "1" : "0"} data-step={state}>
                <div className="src-step" data-step={state}>
                  <span className="src-step__o">
                    {t("position", { n: entry.position })} {t(`mark.${state}`)}
                  </span>
                  <span className="src-step__n">{entry.id}</span>
                  <span className="flex flex-wrap items-center gap-1">
                    <EnabledBadge enabled={entry.enabled} data-testid="enabled-badge">
                      {entry.enabled ? tCard("enabled") : tCard("disabled")}
                    </EnabledBadge>
                    {entry.login ? (
                      <Badge variant={entry.login.status === "valid" ? "outline" : entry.login.status === "expired" ? "gate-bad" : "gate-warn"} data-testid="cascade-login-status" data-status={entry.login.status}>
                        {tCard(`login.${entry.login.status}`)}
                      </Badge>
                    ) : null}
                    {entry.notConfigured ? (
                      <Badge variant="gate-warn" data-testid="cascade-not-configured">
                        {tCard("notConfigured")}
                      </Badge>
                    ) : null}
                    {entry.circuit && entry.circuit !== "closed" ? <Badge variant="gate-bad">{tCard(`circuit.${entry.circuit}`)}</Badge> : null}
                  </span>
                  <span className="src-step__t flex flex-wrap gap-x-3 gap-y-0.5">
                    {entry.latest ? (
                      <>
                        {entry.latest.succeeded > 0 ? <b>{t("served", { count: entry.latest.succeeded })}</b> : null}
                        {/* an interrupted query (failed after some pages) was not served either */}
                        {entry.latest.failed + entry.latest.interrupted > 0 ? <span>{t("failed", { count: entry.latest.failed + entry.latest.interrupted })}</span> : null}
                        {entry.latest.skipped > 0 ? <span>{t("skipped", { count: entry.latest.skipped })}</span> : null}
                      </>
                    ) : hasCycle ? (
                      <span>{t("notUsed")}</span>
                    ) : null}
                  </span>
                  {quota.kind === "none" ? (
                    <span className="src-step__t" data-testid="cascade-quota" data-kind="none">
                      {t("quota.none")}
                    </span>
                  ) : (
                    <div className="flex flex-col gap-1" data-testid="cascade-quota" data-kind={quota.kind}>
                      <Battery value={quota.limit > 0 ? (quota.used / quota.limit) * 100 : 0} threshold={alertPercent} tone={state === "on" ? "ink" : "t4"} ariaLabel={t(`quota.${quota.kind}`)} />
                      <span className="src-step__t font-mono">
                        {quota.kind === "free"
                          ? tBudget("records", { used: format.number(quota.used), limit: format.number(quota.limit) })
                          : tBudget("usd", { used: formatUsd(format, quota.used), limit: formatUsd(format, quota.limit) })}
                      </span>
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        {hasCycle && !anyLatest ? <p className="text-ink-2 text-body-sm">{t("none")}</p> : null}
      </CardContent>
    </Card>
  );
}
