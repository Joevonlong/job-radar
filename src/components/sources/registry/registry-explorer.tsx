"use client";

import { Plus, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";
import { useMemo, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { ATS_KINDS } from "@/lib/config/schemas/companies";
import { REGISTRY_GROUPS, type RegistryGroup } from "@/lib/sources/registry/groups";
import { filterRegistryRows } from "@/lib/sources/registry/filter";
import { REGISTRY_QUERY_MAX, REGISTRY_TYPE_FILTERS, registryParsers } from "@/lib/sources/registry/params";
import { REGISTRY_STATUSES, type RegistryStatus } from "@/lib/sources/registry/status";
import type { BoardRow, RegistryView } from "@/lib/sources/registry/view";
import { cn } from "@/lib/utils";

import { BoardDialog, DeleteBoardDialog } from "./board-dialog";
import { BOARD_GRID, BoardRowView, CHANNEL_GRID, ChannelRowView } from "./rows";
import { StatusSummary } from "./status-summary";

export type ReadOnlyReason = "invalid" | null;

interface ExplorerProps {
  view: RegistryView;
  /** Server time (ISO): server and browser render the same relative times. */
  nowIso: string;
  timeZone: string;
  readOnly: ReadOnlyReason;
  alertPercent: number;
}

function Header({ grid, labels }: { grid: string; labels: readonly string[] }) {
  return (
    <div role="row" className={cn("text-cap-style bg-soft border-border hidden border-b-bw px-3 py-2 @4xl:grid", grid)}>
      {labels.map((label, index) => (
        <div key={`${label}-${index}`} role="columnheader" className="min-w-0">
          {label}
        </div>
      ))}
    </div>
  );
}

/** The two tables of the registry (cards below 1280px): channels by group, and the ATS boards. The URL holds the filters. */
export function RegistryExplorer({ view, nowIso, timeZone, readOnly, alertPercent }: ExplorerProps) {
  const t = useTranslations("sourcesRegistry");
  const now = useMemo(() => new Date(nowIso), [nowIso]);
  const [params, setParams] = useQueryStates(registryParsers, { history: "replace" });
  const [boardDialog, setBoardDialog] = useState<{ open: boolean; board: BoardRow | null }>({ open: false, board: null });
  const [deleting, setDeleting] = useState<BoardRow | null>(null);
  const readOnlyHint = readOnly === null ? null : t(`readOnly.${readOnly}`);

  const filters = { type: params.type, statuses: params.status, ats: params.ats, q: params.q.slice(0, REGISTRY_QUERY_MAX) };
  const shown = filterRegistryRows(view, filters);
  const filtered = params.type !== "all" || params.status.length > 0 || params.ats !== null || params.q !== "";

  const toggleStatus = (status: RegistryStatus) => {
    const next = params.status.includes(status) ? params.status.filter((s) => s !== status) : REGISTRY_STATUSES.filter((s) => s === status || params.status.includes(s));
    void setParams({ status: next.length > 0 ? next : null });
  };
  const summaryToggle = (status: RegistryStatus) => {
    const only = params.status.length === 1 && params.status[0] === status;
    void setParams({ status: only ? null : [status] });
  };
  const showBoards = (ats: string) => void setParams({ type: "ats_board", ats: ATS_KINDS.find((k) => k === ats) ?? null });
  const clear = () => void setParams({ type: null, status: null, ats: null, q: null });

  // The channels of other markets are listed apart, folded until asked for
  const channelGroups = REGISTRY_GROUPS.map((group) => ({ group, rows: shown.channels.filter((row) => row.group === group && !row.otherMarket) })).filter((entry) => entry.rows.length > 0);
  const otherMarketRows = shown.channels.filter((row) => row.otherMarket);
  const [showOtherMarkets, setShowOtherMarkets] = useState(false);
  const boardCount = shown.boards.length === view.boards.length ? String(view.boards.length) : `${shown.boards.length} / ${view.boards.length}`;
  const channelCount = shown.channels.length === view.channels.length ? String(view.channels.length) : `${shown.channels.length} / ${view.channels.length}`;

  return (
    <div className="@container flex flex-col gap-4" data-testid="registry-explorer" data-read-only={readOnly ?? "no"}>
      <StatusSummary counts={view.counts} selected={params.status} onToggle={summaryToggle} />

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2" role="search" aria-label={t("filters.label")} data-testid="registry-filters">
        <Segmented aria-label={t("filters.type")} value={params.type} onValueChange={(next) => void setParams({ type: REGISTRY_TYPE_FILTERS.find((k) => k === next) ?? "all", ats: next === "channel" ? null : params.ats })} data-testid="type-filter">
          {REGISTRY_TYPE_FILTERS.map((type) => (
            <SegmentedItem key={type} value={type} data-testid={`type-${type}`}>
              {t(`type.${type}`)}
            </SegmentedItem>
          ))}
        </Segmented>
        <div role="group" aria-label={t("filters.status")} className="flex flex-wrap gap-1.5" data-testid="status-filter">
          {REGISTRY_STATUSES.map((status) => (
            <Button key={status} type="button" size="sm" variant="default" aria-pressed={params.status.includes(status)} onClick={() => toggleStatus(status)} data-testid={`status-${status}`}>
              {t(`status.${status}`)}
            </Button>
          ))}
        </div>
        <div className="min-w-48 flex-1 sm:max-w-80">
          <Input
            type="search"
            size="sm"
            prefix={<Search aria-hidden className="size-3.5" />}
            value={params.q}
            maxLength={REGISTRY_QUERY_MAX}
            onChange={(event) => void setParams({ q: event.target.value === "" ? null : event.target.value })}
            placeholder={t("filters.search")}
            aria-label={t("filters.search")}
            data-testid="registry-search"
          />
        </div>
        {filtered ? (
          <Button type="button" variant="ghost" size="sm" onClick={clear} data-testid="filters-clear">
            {t("filters.clear")}
          </Button>
        ) : null}
      </div>

      {params.type !== "ats_board" ? (
        <section aria-labelledby="registry-channels-title" className="flex flex-col gap-2" data-testid="channels-table">
          <h2 id="registry-channels-title" className="font-display text-h2">
            {t("channels.title")} · <span data-testid="channels-count">{channelCount}</span>
          </h2>
          <div role="table" aria-label={t("channels.title")} className="rounded-card border-border bg-card shadow-e3 overflow-hidden border-bw">
            <Header grid={CHANNEL_GRID} labels={[t("cols.status"), t("cols.source"), t("cols.enabled"), t("cols.lastRun"), t("cols.lastSuccess"), t("cols.window", { days: view.windowDays }), t("cols.reason"), ""]} />
            {channelGroups.length === 0 && otherMarketRows.length === 0 ? (
              <p className="text-ink-2 px-3 py-4 text-body-sm" data-testid="channels-empty">
                {t("empty")}
              </p>
            ) : (
              <>
                {channelGroups.map(({ group, rows }) => (
                  <div key={group} role="rowgroup" data-testid={`group-${group}`}>
                    <div role="row" className="bg-soft text-cap-style text-ink-2 border-grid border-t-[1.5px] px-3 py-1 first:border-t-0">
                      <span role="rowheader">{t(`group.${group satisfies RegistryGroup}`)}</span>
                    </div>
                    {rows.map((row) => (
                      <ChannelRowView key={row.id} row={row} now={now} timeZone={timeZone} readOnlyHint={readOnlyHint} windowDays={view.windowDays} alertPercent={alertPercent} onShowBoards={showBoards} />
                    ))}
                  </div>
                ))}
                {otherMarketRows.length > 0 ? (
                  <div role="rowgroup" data-testid="group-other-market">
                    <div role="row" className="bg-soft text-cap-style text-ink-2 border-grid flex flex-wrap items-center gap-x-3 border-t-[1.5px] px-3 py-1 first:border-t-0">
                      <span role="rowheader">{t("group.otherMarket")}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={showOtherMarkets}
                        aria-controls="registry-other-markets"
                        onClick={() => setShowOtherMarkets((open) => !open)}
                        data-testid="other-markets-toggle"
                      >
                        {showOtherMarkets ? t("row.hideOtherMarkets") : t("row.showOtherMarkets", { count: otherMarketRows.length })}
                      </Button>
                    </div>
                    <div id="registry-other-markets" hidden={!showOtherMarkets}>
                      {showOtherMarkets
                        ? otherMarketRows.map((row) => (
                            <ChannelRowView key={row.id} row={row} now={now} timeZone={timeZone} readOnlyHint={readOnlyHint} windowDays={view.windowDays} alertPercent={alertPercent} onShowBoards={showBoards} />
                          ))
                        : null}
                    </div>
                  </div>
                ) : null}
              </>
            )}
          </div>
        </section>
      ) : null}

      {params.type !== "channel" ? (
        <section aria-labelledby="registry-boards-title" className="flex flex-col gap-2" data-testid="boards-table">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h2 id="registry-boards-title" className="font-display text-h2">
              {t("boards.title")} · <span data-testid="boards-count">{boardCount}</span>
            </h2>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <NativeSelect size="sm" aria-label={t("boards.atsFilter")} value={params.ats ?? ""} onChange={(event) => void setParams({ ats: ATS_KINDS.find((k) => k === event.target.value) ?? null })} data-testid="ats-filter" className="w-44">
                <option value="">{t("boards.allAts")}</option>
                {ATS_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </NativeSelect>
              <Button type="button" size="sm" variant="primary" disabled={readOnly !== null} title={readOnlyHint ?? undefined} onClick={() => setBoardDialog({ open: true, board: null })} data-testid="board-add">
                <Plus aria-hidden />
                {t("boards.add")}
              </Button>
            </div>
          </div>
          <div role="table" aria-label={t("boards.title")} className="rounded-card border-border bg-card shadow-e3 overflow-hidden border-bw">
            <Header grid={BOARD_GRID} labels={[t("cols.status"), t("cols.company"), t("cols.enabled"), t("cols.lastCheck"), t("cols.lastSuccess"), t("cols.postings"), t("cols.reason"), ""]} />
            {shown.boards.length === 0 ? (
              <p className="text-ink-2 px-3 py-4 text-body-sm" data-testid="boards-empty">
                {t("empty")}
              </p>
            ) : (
              <div role="rowgroup">
                {shown.boards.map((row) => (
                  <BoardRowView key={row.id} row={row} now={now} timeZone={timeZone} readOnlyHint={readOnlyHint} windowDays={view.windowDays} onEdit={(board) => setBoardDialog({ open: true, board })} onDelete={setDeleting} />
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}

      <BoardDialog open={boardDialog.open} board={boardDialog.board} onOpenChange={(open) => setBoardDialog((current) => ({ ...current, open }))} />
      <DeleteBoardDialog board={deleting} onOpenChange={(open) => (open ? undefined : setDeleting(null))} />
    </div>
  );
}
