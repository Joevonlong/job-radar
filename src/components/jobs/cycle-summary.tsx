import { Clock } from "lucide-react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { AiRunStatus } from "@/components/ai-run-status";
import { problemSteps, processingFailed } from "@/lib/cycle/step-health";
import { outcomeTone, TONE_DOT } from "@/lib/sources/channel-tone";
import type { NextCycle } from "@/lib/dashboard/next-cycle";
import type { AiRunProgress } from "@/lib/db/queries/ai-run";
import type { CycleChannelSummary, CycleSummary } from "@/lib/db/queries/today";
import { cn } from "@/lib/utils";

import { CycleDisclosure } from "./cycle-disclosure";
import { cycleFace, STATE_TONE, stateWords, type Translator } from "./cycle-state";

interface CycleSummaryProps {
  summary: CycleSummary | null;
  next: NextCycle | null;
  timezone: string;
  now: Date;
  /** The AI part of a cycle that the ai-worker has not finished; null when there is none. */
  aiRun?: AiRunProgress | null;
  /** The database clock (the AI request's times are stamped by it); default `now`. */
  dbNow?: Date;
  /** Enabled channels that lack a required environment variable: channel id → variable names (never values). */
  missingEnv?: Readonly<Record<string, readonly string[]>>;
}

const KNOWN_ERROR_CODES = ["rate_limited", "blocked", "auth_expired", "budget_exceeded", "network", "parse", "unknown"] as const;

/** The strip at the top of Today: the latest cycle, when the next one is due, and what each channel did. */
export async function CycleSummaryStrip({ summary, next, timezone, now, aiRun = null, dbNow = now, missingEnv = {} }: CycleSummaryProps) {
  const [t, format] = await Promise.all([getTranslations("dashboard.cycle"), getFormatter()]);
  const time = (date: Date) => format.dateTime(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });

  const aiRunNotice = aiRun ? (
    <div className="border-border border-t-bw px-4 py-2.5" data-testid="cycle-ai-run">
      <AiRunStatus
        status={aiRun.status}
        cycleId={aiRun.cycleId}
        elapsedSeconds={Math.floor((dbNow.getTime() - (aiRun.startedAt ?? aiRun.requestedAt).getTime()) / 1000)}
        scored={aiRun.scored}
        translated={aiRun.translated}
      />
    </div>
  ) : null;

  if (summary === null) {
    return (
      <section aria-labelledby="cycle-heading" className="border-border bg-card text-card-foreground rounded-card border-bw shadow-e2" data-testid="cycle-summary">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-2.5">
          <span id="cycle-heading" className="inline-flex items-center gap-2 font-medium">
            <Clock className="size-4" aria-hidden /> {t("none")}
          </span>
          <span className="text-muted-foreground">{t("noneHint")}</span>
          {next ? <span className="text-muted-foreground">{t("next", { kind: t(`kind.${next.kind}`), when: formatWhen(format, next.at, now, timezone) })}</span> : null}
        </div>
        {aiRunNotice}
      </section>
    );
  }

  const face = cycleFace(summary);
  const stateText = stateWords(t, face, time, summary);
  // the pipeline failed: "0 new jobs" would be a lie, the postings are waiting
  const waiting = processingFailed(summary.steps) && summary.unprocessed > 0;
  const headline = (
    <>
      {t("run", { kind: t(`kind.${summary.kind}`), time: time(summary.startedAt) })} · <span className={STATE_TONE[face.tone]}>{stateText}</span>
    </>
  );
  // sources that failed have their own chips and count; a step that failed is what needs words
  const problems = problemSteps(summary.steps);
  const problem = problems.failed.length + problems.partial.length > 0 ? <CycleProblem summary={summary} t={t} /> : null;

  return (
    <section aria-labelledby="cycle-heading" className="border-border bg-card text-card-foreground rounded-card border-bw shadow-e2" data-testid="cycle-summary" data-cycle-id={summary.id} data-tone={face.tone}>
      <CycleDisclosure
        label={t("summaryToggle")}
        line={
          <>
            {headline}
            {waiting ? (
              <span className="text-muted-foreground"> · {summary.unprocessed} {t("stat.waiting")}</span>
            ) : summary.newCount > 0 ? (
              <span className="text-muted-foreground"> · {summary.newCount} {t("stat.new")}</span>
            ) : null}
          </>
        }
        header={
          <div className="border-border flex flex-wrap items-center gap-x-6 gap-y-2 border-b-bw px-4 py-2.5">
            <span id="cycle-heading" className="inline-flex min-w-0 items-center gap-2 font-medium">
              <Clock className="size-4 flex-none" aria-hidden />
              <span>{headline}</span>
            </span>
            {next ? <span className="text-muted-foreground">{t("next", { kind: t(`kind.${next.kind}`), when: formatWhen(format, next.at, now, timezone) })}</span> : null}
            <dl className="flex flex-wrap gap-x-6 gap-y-2 md:ml-auto">
              {/* fetched / passed / qualified are summary blocks (KpiStrip); the rest of the cycle's counts stay here */}
              {waiting ? <Stat label={t("stat.waiting")} value={summary.unprocessed} bad /> : <Stat label={t("stat.new")} value={summary.newCount} />}
              {summary.mergedCount !== null ? <Stat label={t("stat.merged")} value={summary.mergedCount} /> : null}
              <Stat label={t("stat.failed")} value={summary.failedChannels} bad={summary.failedChannels > 0} />
            </dl>
          </div>
        }
      >
        {problem}
        {summary.channels.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5 px-4 py-2.5" aria-label={t("channelsLabel")}>
            {summary.channels.map((channel) => (
              <ChannelChip key={channel.channelId} channel={channel} format={format} timezone={timezone} now={now} t={t} missingEnv={missingEnv[channel.channelId] ?? []} />
            ))}
          </ul>
        ) : null}
        {aiRunNotice}
      </CycleDisclosure>
    </section>
  );
}

/** What went wrong in plain words, what it means for the numbers below, and where to look (the Sources page). Never a dev-doc path. */
function CycleProblem({ summary, t }: { summary: CycleSummary; t: Translator }) {
  const { failed, partial } = problemSteps(summary.steps);
  return (
    <div className="border-border flex flex-col gap-1 border-b-bw bg-soft px-4 py-2.5 text-[13px]" role="status" data-testid="cycle-problem">
      <p className="font-medium">{t("problemTitle")}</p>
      {summary.unprocessed > 0 && failed.some((name) => name === "pipeline" || name === "filter") ? (
        <p data-testid="cycle-unprocessed" data-count={summary.unprocessed}>
          {t("unprocessed", { fetched: summary.fetched, count: summary.unprocessed })}
        </p>
      ) : null}
      <ul className="text-muted-foreground list-disc pl-5">
        {failed.map((name) => (
          <li key={name} data-step={name}>
            <b className="text-foreground font-semibold">{t(`step.${name}`)}</b> · {t(`stepHelp.${name}`)}
          </li>
        ))}
        {/* a step that only half worked is named too, with what that means: the strip, the ticker and the sidebar already list it */}
        {partial
          .filter((name) => !failed.includes(name))
          .map((name) => (
            <li key={name} data-step={name} data-status="partial">
              <b className="text-foreground font-semibold">{t(`step.${name}`)}</b> · {t(`stepHelpPartial.${name}`)}
            </li>
          ))}
      </ul>
      <Link href="/sources" className="w-fit font-medium underline underline-offset-2" data-testid="cycle-problem-link">
        {t("problemLink")} →
      </Link>
    </div>
  );
}

/**
 * Every cycle of today under the latest one: an extra manual run never hides the morning's. Each row
 * says which run it was, when, how it ended, how many jobs it found / let through / qualified, and
 * which sources failed. Shown only when there is more than one cycle today (one is the strip above).
 */
export async function TodayCyclesList({ cycles, timezone }: { cycles: readonly CycleSummary[]; timezone: string }) {
  const [t, format] = await Promise.all([getTranslations("dashboard.cycle"), getFormatter()]);
  if (cycles.length < 2) return null;
  const time = (date: Date) => format.dateTime(date, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
  const totalNew = cycles.reduce((sum, c) => sum + c.newCount, 0);
  const totalPassed = cycles.reduce((sum, c) => sum + c.passedCount, 0);

  const rows = (
    <ol className="divide-grid divide-y-[1.5px]" aria-label={t("todayLabel")}>
      {cycles.map((cycle) => {
        const failed = cycle.channels.filter((c) => c.outcome === "failed" || c.outcome === "circuit_open");
        const face = cycleFace(cycle);
        const state = stateWords(t, face, time, cycle);
        const waiting = processingFailed(cycle.steps) && cycle.unprocessed > 0;
        return (
          <li key={cycle.id} className="flex flex-wrap items-baseline gap-x-5 gap-y-1.5 px-4 py-2.5 text-[13px]" data-testid="today-cycle" data-cycle-id={cycle.id} data-kind={cycle.kind}>
            <span className="min-w-0 font-medium">
              {t("run", { kind: t(`kind.${cycle.kind}`), time: time(cycle.startedAt) })} <span className={cn("font-normal", face.tone === "ok" ? "text-muted-foreground" : STATE_TONE[face.tone])}>· {state}</span>
            </span>
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              {waiting ? (
                <Stat small bad label={t("stat.waiting")} value={cycle.unprocessed} />
              ) : (
                <>
                  <Stat small label={t("stat.new")} value={cycle.newCount} />
                  <Stat small label={t("stat.passed")} value={cycle.passedCount} />
                  {cycle.qualifiedCount !== null ? <Stat small label={t("stat.qualified")} value={cycle.qualifiedCount} /> : null}
                </>
              )}
              <Stat small label={t("stat.fetched")} value={cycle.fetched} />
            </dl>
            {failed.length > 0 ? (
              <span className="text-destructive min-w-0" data-testid="today-cycle-failed">
                {t("failedSources")}: {failed.map((c) => c.channelId).join(", ")}
              </span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
  const title = t("todayTitle", { count: cycles.length });

  return (
    <section aria-labelledby="today-cycles-heading" className="border-border bg-card text-card-foreground rounded-card border-bw shadow-e2" data-testid="today-cycles">
      {/* a phone shows one line (the first job must be on the first screen); the rows open from it */}
      <CycleDisclosure
        label={title}
        line={
          <span className="font-medium">
            {title} <span className="text-muted-foreground font-normal">· {t("todayTotals", { fresh: totalNew, passed: totalPassed })}</span>
          </span>
        }
        header={
          <div className="border-border flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b-bw bg-soft px-4 py-2.5">
            <h2 id="today-cycles-heading" className="text-sm font-medium">
              {title}
            </h2>
            <span className="text-muted-foreground text-[13px]" data-testid="today-cycles-total">
              {t("todayTotals", { fresh: totalNew, passed: totalPassed })}
            </span>
          </div>
        }
        className="border-border max-md:border-t-bw"
      >
        {rows}
      </CycleDisclosure>
    </section>
  );
}

function formatWhen(format: Awaited<ReturnType<typeof getFormatter>>, at: Date, now: Date, timezone: string): string {
  const sameDay = format.dateTime(at, { dateStyle: "short", timeZone: timezone }) === format.dateTime(now, { dateStyle: "short", timeZone: timezone });
  return sameDay
    ? format.dateTime(at, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone })
    : format.dateTime(at, { weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: timezone });
}

function Stat({ label, value, bad = false, small = false }: { label: string; value: number; bad?: boolean; small?: boolean }) {
  return (
    <div className="text-muted-foreground flex items-baseline gap-1.5 text-[13px]" data-bad={bad ? "1" : undefined}>
      <dd className={cn("order-first font-mono leading-none font-medium tabular-nums", small ? "text-[13px]" : "text-base", bad ? "text-destructive" : "text-foreground")}>{value}</dd>
      <dt>{label}</dt>
    </div>
  );
}

function ChannelChip({ channel, format, timezone, now, t, missingEnv = [] }: { channel: CycleChannelSummary; format: Awaited<ReturnType<typeof getFormatter>>; timezone: string; now: Date; t: Translator; missingEnv?: readonly string[] }) {
  const bad = channel.outcome === "failed" || channel.outcome === "circuit_open";
  const skipped = channel.outcome === "skipped";
  // enabled but missing its key: it cannot have done anything, so never show it green
  const keyMissing = !bad && missingEnv.length > 0;

  let message: string | null = null;
  if (channel.outcome === "circuit_open") {
    message = channel.circuitOpenUntil ? t("circuitOpenUntil", { when: formatWhen(format, channel.circuitOpenUntil, now, timezone) }) : t("circuitOpen");
  } else if (bad || skipped) {
    const code = KNOWN_ERROR_CODES.find((c) => c === channel.errorCode);
    message = code ? t(`error.${code}`) : t(skipped ? "outcome.skipped" : "outcome.failed");
  }

  return (
    <li
      className={cn(
        "border-border bg-card inline-flex h-7 max-w-full min-w-0 items-center gap-2 rounded-tag border-bw px-2.5 font-mono text-data",
        bad && "bg-bad/10 border-bad",
      )}
      data-state={channel.outcome}
      data-missing-env={keyMissing ? missingEnv.join(",") : undefined}
      data-channel={channel.channelId}
      title={keyMissing ? t("missingEnvTitle", { names: missingEnv.join(", ") }) : t("channelTitle", { fetched: channel.fetched, fresh: channel.newCount })}
    >
      <span aria-hidden className={cn("size-[7px] flex-none rounded-full", TONE_DOT[outcomeTone({ outcome: channel.outcome, keyMissing })])} />
      <span className="truncate">{channel.channelId}</span>
      <span className="text-muted-foreground font-mono tabular-nums">{channel.fetched}</span>
      {keyMissing ? (
        <span className="text-warning-text truncate" data-testid="chip-missing-env">
          {t("missingEnv", { names: missingEnv.join(", ") })}
        </span>
      ) : null}
      {message ? <span className={cn("truncate", bad ? "text-destructive" : "text-muted-foreground")}>{message}</span> : null}
    </li>
  );
}
