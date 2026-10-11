import { getFormatter, getTranslations } from "next-intl/server";

import { TriggerButton } from "@/components/control/trigger-button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Led, NumberRoll, Sparkline, UptimeStrip } from "@/components/viz";
import { ARBEITNOW_SITE_URL } from "@/lib/channels/arbeitnow/site";
import { RUNS_PER_CHANNEL } from "@/lib/settings/constants";
import type { RecentRun } from "@/lib/db/queries/sources";
import { statusTone, TONE_TEXT } from "@/lib/sources/channel-tone";
import type { SourceCard } from "@/lib/sources/view";
import { cn } from "@/lib/utils";

import "./sources.css";
import { formatUsd, formatWhen } from "./format";
import { EnabledBadge } from "./enabled-badge";
import { UsageBar } from "./usage-bar";

const ERROR_CODES = ["rate_limited", "blocked", "auth_expired", "budget_exceeded", "network", "parse", "unknown"] as const;

const RUN_VARIANT = {
  running: "status-on",
  succeeded: "status-good",
  partial: "status-warn",
  failed: "gate-bad",
  skipped: "status",
} as const satisfies Record<RecentRun["status"], "status-on" | "status-good" | "status-warn" | "gate-bad" | "status">;

/** Channels whose data terms ask for a link back: id -> the attribution line under the status and the site it links to. */
const ATTRIBUTIONS = { arbeitnow: { message: "card.attribution.arbeitnow", url: ARBEITNOW_SITE_URL } } as const;
const hasAttribution = (id: string): id is keyof typeof ATTRIBUTIONS => Object.hasOwn(ATTRIBUTIONS, id);

const loginHint = (status: "missing" | "valid" | "expired"): "hintMissing" | "hintValid" | "hintExpired" => (status === "missing" ? "hintMissing" : status === "valid" ? "hintValid" : "hintExpired");

/** One channel: light, this cycle's count with its trend, the health strip of the last cycles, switches, this month's usage against its budget, and its last runs. */
export async function ChannelCard({ card, timeZone, healthCycles, alertPercent }: { card: SourceCard; timeZone: string; healthCycles: number; alertPercent: number }) {
  const [t, tCycle, format] = await Promise.all([getTranslations("sources"), getTranslations("dashboard.cycle"), getFormatter()]);
  const { usage } = card;
  const bad = card.circuit !== null && card.circuit.state !== "closed";
  const needsCredentials = card.enabled && (card.notConfigured || card.missingEnv.length > 0);
  const missingNames = card.missingEnv.join(", ");

  // the one line under the strip: the word for the state, then the single most useful fact (what is missing, when it last worked)
  const detail =
    !card.registered
      ? t("card.notImplementedHint")
      : card.notConfigured || needsCredentials || (!card.enabled && missingNames !== "")
        ? // a switched-off channel never "is enabled but lacks a key": it says what switching it on takes
          !card.enabled
          ? missingNames !== ""
            ? t("card.missingEnvOff", { names: missingNames })
            : t("card.notConfiguredHintOff")
          : missingNames !== ""
            ? t("card.missingEnv", { names: missingNames })
            : t("card.notConfiguredHintShort")
        : [
            card.lastSuccessAt ? t("card.lastSuccess", { when: formatWhen(format, card.lastSuccessAt, timeZone) }) : t("card.neverSucceeded"),
            card.circuit && card.circuit.consecutiveFailures > 0 ? t("card.failures", { count: card.circuit.consecutiveFailures }) : null,
            card.circuit?.state === "open" && card.circuit.openUntil ? t("card.circuitUntil", { when: formatWhen(format, card.circuit.openUntil, timeZone) }) : null,
          ]
            .filter((part): part is string => part !== null)
            .join(" · ");
  const attribution = hasAttribution(card.id) ? ATTRIBUTIONS[card.id] : null;
  const statusLine = card.registered ? `${t(`status.${card.status}`)}${card.history.running ? ` · ${t("status.running")}` : ""}` : null;

  return (
    <Card className="src-ch gap-3 py-3.5" data-testid="channel-card" data-channel={card.id} data-enabled={card.enabled ? "1" : "0"} data-circuit={card.circuit?.state ?? "none"} data-status={card.status}>
      <CardHeader className="gap-1.5 px-4">
        <CardTitle className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <Led tone={statusTone(card.status)} live={card.history.running} label={false} />
          <h3 className="min-w-0 font-mono text-title font-extrabold [overflow-wrap:anywhere]">{card.id}</h3>
          {/* a healthy, switched-on channel needs no badge: the light and the status line say it. Only what deviates is a chip. */}
          {!card.enabled || needsCredentials ? (
            <EnabledBadge enabled={card.enabled} data-testid="enabled-badge" data-state={card.enabled ? "warning" : "off"}>
              {card.enabled ? t("card.enabled") : t("card.disabled")}
            </EnabledBadge>
          ) : null}
          {card.notConfigured ? (
            <Badge variant="gate-warn" title={t(card.id === "linkedin-apify" ? "card.notConfiguredHintApify" : card.id === "jsearch" ? "card.notConfiguredHintJsearch" : card.id === "gmail-alerts" ? "card.notConfiguredHintGmail" : "card.notConfiguredHint")} data-testid="not-configured">
              {t("card.notConfigured")}
            </Badge>
          ) : null}
          {card.login ? (
            <Badge
              variant={card.login.status === "valid" ? "outline" : card.login.status === "expired" ? "gate-bad" : "gate-warn"}
              title={t(`card.login.${loginHint(card.login.status)}`)}
              data-testid="login-status"
              data-status={card.login.status}
            >
              {t(`card.login.${card.login.status}`)}
            </Badge>
          ) : null}
          {!card.registered ? (
            <Badge variant="gate-note" title={t("card.notImplementedHint")}>
              {t("card.notImplemented")}
            </Badge>
          ) : null}
          {card.circuit && !card.notConfigured && bad ? <Badge variant="gate-bad">{t(`card.circuit.${card.circuit.state}`)}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 px-4">
        {card.registered ? (
          <div className="flex flex-col gap-2" data-testid="channel-pulse">
            <div className="src-ch__n">
              <div className="flex flex-col gap-0.5">
                <NumberRoll value={card.history.latest === null ? null : card.history.latest.fetched} />
                <span className="text-ink-3 font-mono text-data-sm">
                  {card.history.latest === null ? t("card.thisCycleNone") : t("card.thisCycle", { fresh: format.number(card.history.latest.newCount) })}
                </span>
              </div>
              <Sparkline values={card.history.fetched} width={90} height={28} />
            </div>
            <UptimeStrip states={card.history.outcomes} count={healthCycles} />
          </div>
        ) : null}
        <p className={cn("src-ch__line font-mono text-data", TONE_TEXT[statusTone(card.status)])} data-testid="channel-status" data-status={card.status} title={[statusLine, detail].filter(Boolean).join(" · ")}>
          {statusLine ? <b className="font-bold">{statusLine}</b> : null}
          {statusLine && detail ? " · " : null}
          <span data-testid={card.notConfigured || needsCredentials || !card.registered ? "missing-env" : undefined} className="font-medium">
            {detail}
          </span>
        </p>
        {attribution ? (
          <p className="text-ink-2 text-data" data-testid="channel-attribution">
            {t.rich(attribution.message, {
              link: (chunks) => (
                <a href={attribution.url} target="_blank" rel="noopener noreferrer" className="text-ink underline underline-offset-4 hover:bg-hi hover:text-hi-ink">
                  {chunks}
                </a>
              ),
            })}
          </p>
        ) : null}

        <details className="src-ch__more mt-auto flex flex-col gap-3" data-testid="channel-details">
          <summary className="text-label font-bold">{t("card.details")}</summary>
          {card.registered ? (
            <div className="grid gap-3 pt-3 sm:grid-cols-2" data-testid="channel-actions">
              <TriggerButton kind="runChannel" target={card.id} disabled={!card.enabled} {...(card.enabled ? {} : { disabledHint: t("card.actions.disabledHint") })} />
              <TriggerButton
                kind="testChannel"
                target={card.id}
                disabled={!card.testable || !card.enabled || card.notConfigured}
                {...(!card.testable ? { disabledHint: t("card.actions.testExcludedHint") } : !card.enabled ? { disabledHint: t("card.actions.disabledHint") } : {})}
              />
            </div>
          ) : null}
          <div className="flex flex-col gap-2.5">
            <h4 className="text-label font-bold">{t("card.usage")}</h4>
            {usage.freeRecords > 0 ? (
              <UsageBar
                value={usage.records}
                max={usage.freeRecords}
                label={t("budget.freeAllowance")}
                valueText={t("budget.records", { used: format.number(usage.records), limit: format.number(usage.freeRecords) })}
                threshold={alertPercent}
                testId="free-bar"
              />
            ) : (
              <p className="text-data" data-testid="month-activity" data-runs={usage.activity.runs} data-fetched={usage.activity.fetched}>
                {usage.activity.runs === 0
                  ? t("budget.noActivity")
                  : t("budget.activity", { requests: format.number(usage.activity.runs), records: format.number(usage.activity.fetched), fresh: format.number(usage.activity.newCount) })}
              </p>
            )}
            {usage.budgetUsd > 0 ? (
              <UsageBar
                value={usage.usd}
                max={usage.budgetUsd}
                label={t("budget.paid")}
                valueText={t("budget.usd", { used: formatUsd(format, usage.usd), limit: formatUsd(format, usage.budgetUsd) })}
                threshold={alertPercent}
                testId="budget-bar"
              />
            ) : (
              <p className="text-ink-2 text-data" data-testid="no-budget">
                {t("budget.noBudget")}
              </p>
            )}
          </div>

          <div className="flex flex-col gap-1.5" data-testid="channel-runs">
            <h4 className="text-label font-bold">{t("card.runs", { count: RUNS_PER_CHANNEL })}</h4>
            {card.runs.length === 0 ? (
              <p className="text-ink-2 text-data">{t("card.noRuns")}</p>
            ) : (
              <ul className="flex flex-col" data-testid="run-list">
                {card.runs.map((run) => {
                  const code = ERROR_CODES.find((c) => c === run.errorCode);
                  return (
                    <li key={run.id} className="border-grid flex flex-wrap items-center gap-x-3 gap-y-1 border-t-[1.5px] py-1.5 text-data first:border-t-0" data-status={run.status} data-run={run.id}>
                      <span className="text-ink-2 w-28 shrink-0 font-mono tabular-nums">{formatWhen(format, run.startedAt, timeZone)}</span>
                      <Badge variant={RUN_VARIANT[run.status]}>{tCycle(`state.${run.status}`)}</Badge>
                      <span className="font-mono tabular-nums" title={t("card.col.fetched")}>
                        {run.fetched}
                      </span>
                      <span className="text-ink-2 font-mono tabular-nums" title={t("card.col.new")}>
                        +{run.newCount}
                      </span>
                      {run.cost > 0 ? <span className="text-ink-2 font-mono tabular-nums">{t("card.runCost", { cost: formatUsd(format, run.cost) })}</span> : null}
                      {run.status === "failed" || run.status === "skipped" ? (
                        <span className="text-bad min-w-0 truncate font-semibold" title={run.error ?? undefined}>
                          {code ? tCycle(`error.${code}`) : tCycle("error.unknown")}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </details>
      </CardContent>
    </Card>
  );
}
