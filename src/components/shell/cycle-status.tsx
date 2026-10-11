"use client";

import Link from "next/link";
import { useFormatter, useLocale, useTranslations } from "next-intl";

import { SegBlocks } from "@/components/viz";
import { LOCALE_META, resolveLocale, type Locale } from "@/i18n/locale";
import { formatInteger, ratioPercent } from "@/lib/format/numbers";
import type { StepName } from "@/lib/cycle/step-health";
import type { ShellCycleKind, ShellStatus } from "@/lib/shell/status-schema";
import { cn } from "@/lib/utils";

import { ageParts } from "@/lib/settings/age";

import { shellHealth, useSharedShellStatus } from "./shell-status-provider";

/**
 * SegBlocks draws with the page's ink and good colours: on the black sidebar (both themes) they are remapped for this
 * subtree only, so unlit cells show as dim outlines and lit cells as terminal green.
 */
const TERMINAL_CELLS = "[--good:var(--term-green)] [--ink:var(--term-dim)] [--ink-2:var(--term-ink)]";

/** Steps of the newest cycle that failed or ended partial, when that cycle is `partial` (a cycle with only failed sources has none: its sources line says it). */
function failedStepsOf(status: ShellStatus): StepName[] {
  const cycle = status.cycle;
  if (!cycle || cycle.status !== "partial") return [];
  // a partly failed fetch is the failed sources: the sources line says it
  return [...cycle.failedSteps, ...cycle.partialSteps.filter((name) => name !== "collect" && !cycle.failedSteps.includes(name))];
}

/** The three faces of the cycle status (idle / running / failed). Pure view: `CycleStatus` feeds it the polled data. */
export function CycleStatusView({ status, className }: { status: ShellStatus | null; className?: string }) {
  const t = useTranslations("shell.cycle");
  const tKind = useTranslations("dashboard.cycle.kind");
  const tStep = useTranslations("dashboard.cycle.step");
  const tStepJoin = useTranslations("dashboard.cycle");
  const format = useFormatter();
  const locale = resolveLocale(useLocale());

  const tAge = useTranslations("settings.control.age");
  const kindLabel = (kind: ShellCycleKind | null) => (kind ? tKind(kind) : "");
  const ageText = (seconds: number) => {
    const parts = ageParts(seconds);
    return tAge(parts.unit, { count: parts.count });
  };
  const nextText = (() => {
    if (!status?.next) return t("nextNone");
    const at = new Date(status.next.at);
    const sameDay = format.dateTime(at, { dateStyle: "short", timeZone: status.timezone }) === format.dateTime(new Date(status.now), { dateStyle: "short", timeZone: status.timezone });
    const when = format.dateTime(at, { ...(sameDay ? {} : { weekday: "short" as const }), hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: status.timezone });
    return t("next", { when });
  })();

  const frame = cn("mt-auto flex flex-col gap-1 rounded-tag border-bw border-term-line p-sp-3 font-mono text-data text-term-ink", className);

  if (status === null) {
    return (
      <section aria-label={t("label")} data-testid="cycle-status" data-state="loading" className={frame}>
        <span className="text-term-dim">{t("loading")}</span>
      </section>
    );
  }

  const health = shellHealth(status);
  // A cycle that ran but whose steps failed is not "idle": say which part did not work, and where to look
  const named = failedStepsOf(status);
  const partialLines =
    status.cycle && named.length > 0 ? (
      <>
        <span className="text-term-amber" role="status" data-testid="cycle-status-partial">
          ▲ {t("partial")} {kindLabel(status.cycle.kind)}
        </span>
        <span className="text-term-bad" data-testid="cycle-status-steps">
          {named.map((name) => tStep(name)).join(tStepJoin("stepJoiner"))} {t("stepsFailed")}
        </span>
        <Link href="/sources" className="w-fit underline underline-offset-2" data-testid="cycle-status-why">
          {t("partialWhy")}
        </Link>
      </>
    ) : null;
  const aiHint =
    status.aiWorker.expected && !status.aiWorker.online ? (
      <span className="text-term-bad" data-testid="cycle-status-ai-offline">
        ▲ {status.aiWorker.ageSeconds === null ? t("aiWorkerNever") : t("aiWorkerStale", { age: ageText(status.aiWorker.ageSeconds) })}
      </span>
    ) : null;

  // the runner itself is silent: never a green IDLE, same rule as the /sources banner
  if (health === "offline") {
    return (
      <section aria-label={t("label")} data-testid="cycle-status" data-state="offline" className={frame}>
        <span className="text-term-bad" role="status">
          ● {t("offline")}
        </span>
        <span data-testid="cycle-status-offline-detail">{status.runner.ageSeconds === null ? t("runnerNever") : t("runnerStale", { age: ageText(status.runner.ageSeconds) })}</span>
        {aiHint}
        {/* A silent runner and a partly failed cycle are two separate facts: both stay on screen */}
        {partialLines}
        <span className="text-term-dim">{nextText}</span>
      </section>
    );
  }

  if (status.state === "running" && status.progress) {
    const { progress } = status;
    const phase = progress.phase === "ai" ? (progress.status === "pending" ? t("aiPending") : t("ai")) : t("fetch");
    return (
      <section aria-label={t("label")} data-testid="cycle-status" data-state="running" data-phase={progress.phase} className={frame}>
        <span className="text-term-amber" role="status">
          ● {t("running")} {kindLabel(progress.kind)}
        </span>
        <span className="flex flex-wrap items-center gap-x-sp-2">
          <SegBlocks
            value={ratioPercent(progress.done, progress.total)}
            tone="good"
            label={false}
            ariaLabel={t("progressLabel", { phase, done: progress.done, total: progress.total })}
            className={TERMINAL_CELLS}
          />
          <span data-testid="cycle-status-count">
            {formatInteger(progress.done, locale)}/{formatInteger(progress.total, locale)}
          </span>
        </span>
        <span className="text-term-dim">{phase}</span>
        {aiHint}
      </section>
    );
  }

  if (status.state === "failed") {
    return (
      <section aria-label={t("label")} data-testid="cycle-status" data-state="failed" className={frame}>
        <span className="text-term-bad" role="status">
          ✕ {t("failed")} {kindLabel(status.cycle?.kind ?? null)}
        </span>
        <span>{t("failedHint")}</span>
        <span className="text-term-dim">{nextText}</span>
        {aiHint}
      </section>
    );
  }

  if (partialLines) {
    return (
      <section aria-label={t("label")} data-testid="cycle-status" data-state="partial" className={frame}>
        {partialLines}
        <span className="text-term-dim">{nextText}</span>
        {aiHint}
      </section>
    );
  }

  const sources = status.sources;
  return (
    <section aria-label={t("label")} data-testid="cycle-status" data-state="idle" className={frame}>
      <span className="text-term-green">● {t("idle")}</span>
      <span>{nextText}</span>
      {sources ? (
        <span className="text-term-dim" data-testid="cycle-status-sources">
          {t("sources", { ok: formatInteger(sources.ok, locale), broken: formatInteger(sources.circuitOpen, locale) })}
          {sources.failed > 0 ? ` · ${t("sourcesFailed", { count: formatInteger(sources.failed, locale) })}` : ""}
        </span>
      ) : null}
      {aiHint}
    </section>
  );
}

/** Sidebar / drawer footer: the cycle status, kept fresh by the shell's shared poll. */
export function CycleStatus({ className }: { className?: string }) {
  const status = useSharedShellStatus() ?? null;
  return <CycleStatusView status={status} className={className} />;
}

/**
 * The phone top bar's compact status: a dot (and a short word when something needs attention), linking to /sources.
 * A stopped runner must be visible without opening the drawer.
 */
/**
 * A short word ("Offline") stays on any phone that has room for it; a longer one ("Partly failed") gives way to the dot
 * below 430px. Wide-character languages (`meta.wide`, CJK) count fewer characters as long.
 */
function wordClass(word: string, locale: Locale): string {
  const wide = LOCALE_META[locale].wide;
  const long = wide ? word.length > 3 : word.length > 7;
  if (long) return "max-[430px]:sr-only";
  return wide ? "max-[340px]:sr-only" : "max-[380px]:sr-only";
}

export function CycleStatusDotView({ status, className }: { status: ShellStatus | null; className?: string }) {
  const t = useTranslations("shell.cycle");
  const locale = resolveLocale(useLocale());
  if (status === null) return null;
  const health = shellHealth(status);
  const face =
    health === "offline"
      ? { state: "offline", tone: "text-term-bad", word: t("dot.offline"), aria: t("offline") }
      : status.state === "failed"
        ? { state: "failed", tone: "text-term-bad", word: t("dot.failed"), aria: t("failed") }
        : status.state === "running"
          ? { state: "running", tone: "text-term-amber", word: t("dot.running"), aria: t("running") }
          : failedStepsOf(status).length > 0
            ? { state: "partial", tone: "text-term-amber", word: t("dot.partial"), aria: t("partial") }
          : health === "aiOffline"
            ? { state: "ai-offline", tone: "text-term-bad", word: t("dot.aiOffline"), aria: t("aiWorkerNever") }
            : { state: "idle", tone: "text-term-green", word: null, aria: t("idle") };
  return (
    <Link
      href="/sources"
      data-testid="cycle-status-dot"
      data-state={face.state}
      aria-label={`${t("label")}: ${face.aria}`}
      className={cn("flex min-h-sp-6 flex-none items-center gap-1 rounded-tag px-sp-1 font-mono text-data-sm whitespace-nowrap", face.tone, className)}
    >
      <span aria-hidden>●</span>
      {/* one line, never wrapped; the English word is wider than the Chinese one, so on a phone it gives way to the dot */}
      {face.word ? <span className={wordClass(face.word, locale)}>{face.word}</span> : null}
    </Link>
  );
}

export function CycleStatusDot({ className }: { className?: string }) {
  return <CycleStatusDotView status={useSharedShellStatus() ?? null} className={className} />;
}
