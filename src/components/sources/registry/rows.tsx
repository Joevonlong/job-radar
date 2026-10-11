"use client";

import { ChevronDown, ExternalLink, Pencil, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Fragment, useState } from "react";

import { TriggerButton } from "@/components/control/trigger-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Battery } from "@/components/viz";
import type { BoardRow, ChannelRow } from "@/lib/sources/registry/view";
import { cn } from "@/lib/utils";

import { EnabledSwitch } from "./enabled-switch";
import { StatusCell } from "./status-cell";
import { useRegistryText } from "./use-registry-text";

/** Column layouts of the desktop grid (xl and up). Below it every row is a card: status, name, switch and the reason, the rest after "details". */
export const CHANNEL_GRID = "@4xl:grid-cols-[112px_minmax(13rem,1.3fr)_56px_minmax(0,1fr)_minmax(0,0.8fr)_84px_minmax(0,1.7fr)_130px]";
export const BOARD_GRID = "@4xl:grid-cols-[112px_minmax(13rem,1.4fr)_56px_minmax(0,1fr)_minmax(0,0.8fr)_130px_minmax(0,1.6fr)_200px]";

const ROW_BASE = "grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1.5 border-t-[1.5px] border-grid px-3 py-2.5 first:border-t-0 @4xl:items-center @4xl:gap-y-0";
const SPAN = "col-span-3 @4xl:col-span-1";

/** The edit link of a channel: `/settings?tab=channels&section=<id>` opens that channel's section. The "recommended" side channel shares the session section. */
export function settingsHref(channelId: string): string {
  return `/settings?tab=channels&section=${encodeURIComponent(channelId === "linkedin-session:recommended" ? "linkedin-session" : channelId)}`;
}

/** An id that may only break after a ":" or "/" (never in the middle of a word): `linkedin-session:` / `recommended`. */
export function BreakableId({ id }: { id: string }) {
  const parts = id.split(/(?<=[:/])/);
  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 ? <wbr /> : null}
          <span>{part}</span>
        </Fragment>
      ))}
    </>
  );
}

function Extra({ label, expanded, children, className, testId }: { label: string; expanded: boolean; children: React.ReactNode; className?: string; testId?: string }) {
  return (
    <div role="cell" data-testid={testId} className={cn(SPAN, "min-w-0 items-baseline justify-between gap-3 font-mono text-data @4xl:flex @4xl:justify-start", expanded ? "flex" : "hidden @4xl:flex", className)}>
      <span className="text-ink-3 @4xl:hidden">{label}</span>
      <span className="min-w-0 text-right @4xl:text-left">{children}</span>
    </div>
  );
}

export function ChannelRowView({ row, now, timeZone, readOnlyHint, windowDays, alertPercent, onShowBoards }: { row: ChannelRow; now: Date; timeZone: string; readOnlyHint: string | null; windowDays: number; alertPercent: number; onShowBoards: (ats: string) => void }) {
  const t = useTranslations("sourcesRegistry");
  const tAct = useTranslations("sources.card.actions");
  const text = useRegistryText(timeZone);
  const [expanded, setExpanded] = useState(false);
  const reasonText = text.reasons(row.reasons);
  const run = row.lastRun;
  const { detail } = row;

  return (
    <div role="row" className={cn(ROW_BASE, "@4xl:grid", CHANNEL_GRID)} data-testid="registry-row" data-kind="channel" data-id={row.id} data-status={row.status} data-enabled={row.enabled ? "1" : "0"}>
      <div role="cell" className="min-w-0">
        <StatusCell status={row.status} />
      </div>
      <div role="cell" className="min-w-0">
        <p className="font-mono text-title font-extrabold break-words" data-testid="row-id">
          <BreakableId id={row.id} />
        </p>
        {row.boards ? (
          <button type="button" onClick={() => onShowBoards(row.id)} className="text-ink-2 mt-0.5 cursor-pointer text-left font-mono text-data underline-offset-4 hover:underline" data-testid="board-summary">
            {t("row.boardsSummary", { total: row.boards.total, failing: row.boards.failing + row.boards.degraded, never: row.boards.neverRun })}
          </button>
        ) : null}
      </div>
      <div role="cell" className="justify-self-end @4xl:justify-self-start">
        <EnabledSwitch id={row.id} name={row.id} enabled={row.enabled} readOnlyHint={readOnlyHint} consent={row.consent} lockedHint={row.otherMarket ? t("row.otherMarket", { markets: row.markets.join(", ") }) : row.needsParent ? t("row.needsParent", { channel: row.needsParent }) : null} />
      </div>
      <div role="cell" className={cn(SPAN, "min-w-0 text-body-sm @4xl:order-7")} title={reasonText} data-testid="reason">
        <span className={cn("block break-words @4xl:line-clamp-2", row.status === "ok" || row.status === "off" ? "text-ink-2" : "text-ink font-semibold")}>{reasonText}</span>
      </div>
      <Extra label={t("cols.lastRun")} expanded={expanded}>
        {run ? (
          <span title={text.full(run.at)}>
            {text.relative(run.at, now)} · {t(`run.${run.status === "succeeded" || run.status === "partial" || run.status === "failed" || run.status === "skipped" ? run.status : "skipped"}`)}
          </span>
        ) : (
          "—"
        )}
      </Extra>
      <Extra label={t("cols.lastSuccess")} expanded={expanded}>
        {row.lastSuccessAt ? <span title={text.full(row.lastSuccessAt)}>{text.relative(row.lastSuccessAt, now)}</span> : "—"}
      </Extra>
      <Extra label={t("cols.window", { days: windowDays })} expanded={expanded} className="@4xl:justify-end">
        <span data-testid="window">{row.window.runs === 0 ? "—" : `${row.window.fetched} / ${row.window.newCount}`}</span>
      </Extra>
      <div role="cell" className={cn(SPAN, "flex flex-wrap items-center justify-end gap-2 @4xl:order-8")}>
        <Link href={settingsHref(row.id)} className={cn("text-label font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink", expanded ? "inline" : "hidden @4xl:inline")} data-testid="edit-params">
          {t("row.editParams")}
        </Link>
        <Button type="button" variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} data-testid="row-details-toggle">
          <ChevronDown aria-hidden className={cn("transition-transform duration-fast", expanded && "rotate-180")} />
          {t("row.details")}
        </Button>
      </div>
      {expanded ? (
        <div role="cell" className={cn(SPAN, "@4xl:col-span-8 @4xl:order-9 border-grid grid gap-3 border-t-[1.5px] pt-3 sm:grid-cols-2")} data-testid="row-details">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 font-mono text-data">
            <dt className="text-ink-3">{t("detail.circuit")}</dt>
            <dd>{detail.circuit ? t(`detail.circuitState.${detail.circuit.state}`) : "—"}</dd>
            <dt className="text-ink-3">{t("detail.failures")}</dt>
            <dd>{detail.circuit ? detail.circuit.consecutiveFailures : "—"}</dd>
            <dt className="text-ink-3">{t("detail.lastError")}</dt>
            <dd>{detail.circuit?.lastErrorCode ? text.errorLabel(detail.circuit.lastErrorCode) : "—"}</dd>
            <dt className="text-ink-3">{t("detail.openUntil")}</dt>
            <dd>{detail.circuit?.state === "open" && detail.circuit.openUntil ? text.when(detail.circuit.openUntil) : "—"}</dd>
            <dt className="text-ink-3">{t("detail.runs", { days: windowDays })}</dt>
            <dd>{t("detail.runsValue", { runs: row.window.runs, failed: row.window.failed })}</dd>
          </dl>
          <div className="flex min-w-0 flex-col gap-2">
            {detail.usage.budgetUsd > 0 ? (
              <div className="flex flex-col gap-1">
                <span className="font-mono text-data">{t("detail.budget", { used: `$${detail.usage.usd.toFixed(2)}`, limit: `$${detail.usage.budgetUsd.toFixed(2)}` })}</span>
                <Battery value={(detail.usage.usd / detail.usage.budgetUsd) * 100} threshold={alertPercent} ariaLabel={t("detail.budgetLabel")} />
              </div>
            ) : (
              <span className="text-ink-2 font-mono text-data">{t("detail.noBudget")}</span>
            )}
            {detail.registered ? (
              <div className="grid gap-2 sm:grid-cols-2" data-testid="row-actions">
                <TriggerButton kind="runChannel" target={row.id} disabled={!row.enabled} {...(row.enabled ? {} : { disabledHint: tAct("disabledHint") })} />
                <TriggerButton
                  kind="testChannel"
                  target={row.id}
                  disabled={!detail.testable || !row.enabled || row.status === "not_configured"}
                  {...(!detail.testable ? { disabledHint: tAct("testExcludedHint") } : !row.enabled ? { disabledHint: tAct("disabledHint") } : {})}
                />
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function BoardRowView({ row, now, timeZone, readOnlyHint, windowDays, onEdit, onDelete }: { row: BoardRow; now: Date; timeZone: string; readOnlyHint: string | null; windowDays: number; onEdit: (row: BoardRow) => void; onDelete: (row: BoardRow) => void }) {
  const t = useTranslations("sourcesRegistry");
  const text = useRegistryText(timeZone);
  const [expanded, setExpanded] = useState(false);
  const reasonText = text.reasons(row.reasons);
  const check = row.lastCheck;

  return (
    <div role="row" className={cn(ROW_BASE, "@4xl:grid", BOARD_GRID)} data-testid="registry-row" data-kind="ats_board" data-id={row.id} data-status={row.status} data-enabled={row.enabled ? "1" : "0"}>
      <div role="cell" className="min-w-0">
        <StatusCell status={row.status} />
      </div>
      <div role="cell" className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-2 text-title font-extrabold break-words">
          {row.name}
          {row.region === "eu" ? (
            <Badge variant="outline" className="font-mono text-data">
              {t("row.eu")}
            </Badge>
          ) : null}
        </p>
        <p className="text-ink-2 break-words font-mono text-data">
          <BreakableId id={`${row.ats}/${row.token}`} />
        </p>
      </div>
      <div role="cell" className="justify-self-end @4xl:justify-self-start">
        <EnabledSwitch id={row.id} name={row.name} enabled={row.enabled} readOnlyHint={readOnlyHint} />
      </div>
      <div role="cell" className={cn(SPAN, "min-w-0 text-body-sm @4xl:order-7")} title={reasonText} data-testid="reason">
        <span className={cn("block break-words @4xl:line-clamp-2", row.status === "ok" || row.status === "off" ? "text-ink-2" : "text-ink font-semibold")}>{reasonText}</span>
      </div>
      <Extra label={t("cols.lastCheck")} expanded={expanded}>
        {check ? (
          <span title={text.full(check.at)}>
            {text.relative(check.at, now)} · {t(`check.${check.status}`)}
          </span>
        ) : (
          "—"
        )}
      </Extra>
      <Extra label={t("cols.lastSuccess")} expanded={expanded}>
        {row.lastOkAt ? <span title={text.full(row.lastOkAt)}>{text.relative(row.lastOkAt, now)}</span> : "—"}
      </Extra>
      <Extra label={t("cols.postings")} expanded={expanded}>
        <span className="flex flex-col">
          <span>{row.lastTotal === null ? "—" : t("row.returnedKept", { total: row.lastTotal, kept: row.lastKept ?? 0 })}</span>
          <span className="text-ink-2 text-data-sm">{t("row.seen", { days: windowDays, count: row.seen })}</span>
        </span>
      </Extra>
      <div role="cell" className={cn(SPAN, "flex flex-wrap items-center justify-end gap-2 @4xl:order-8")}>
        <span className={cn("flex-wrap items-center gap-2", expanded ? "flex" : "hidden @4xl:flex")}>
          <a href={row.pageUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-label font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink" data-testid="open-board">
            {t("row.openBoard")}
            <ExternalLink aria-hidden className="size-3" />
          </a>
          <Button type="button" size="sm" variant="ghost" disabled={readOnlyHint !== null} title={readOnlyHint ?? undefined} onClick={() => onEdit(row)} data-testid="board-edit" aria-label={t("row.editBoard", { name: row.name })}>
            <Pencil aria-hidden />
            {t("row.edit")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={readOnlyHint !== null} title={readOnlyHint ?? undefined} onClick={() => onDelete(row)} data-testid="board-delete" aria-label={t("row.deleteBoard", { name: row.name })}>
            <Trash2 aria-hidden />
            {t("row.delete")}
          </Button>
        </span>
        <Button type="button" variant="ghost" size="sm" className="@4xl:hidden" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)} data-testid="row-details-toggle">
          <ChevronDown aria-hidden className={cn("transition-transform duration-fast", expanded && "rotate-180")} />
          {t("row.details")}
        </Button>
      </div>
    </div>
  );
}
