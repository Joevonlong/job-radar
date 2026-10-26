/**
 * Text and JSON output of `pnpm sources:list`. Pure: the script reads the data. The table is in the
 * command-line language (`language.yaml: cli.locale`), with the words of the registry page (`sourcesRegistry.*`);
 * `--json` carries codes (status, result, reason keys) only.
 */
import type { Locale } from "@/i18n/locale";
import { translatorFor } from "@/lib/i18n/node";

import type { RegistryReason, RegistryStatus } from "./status";
import { REGISTRY_STATUSES } from "./status";
import type { BoardRow, ChannelRow, RegistryView } from "./view";

/** The registry's words in one language: `sourcesRegistry.*` (shared with the page) and `cli.sourcesList.*` (the table). */
export interface RegistryText {
  locale: Locale;
  r: ReturnType<typeof translatorFor<"sourcesRegistry">>;
  cli: ReturnType<typeof translatorFor<"cli.sourcesList">>;
}

export function registryText(locale: Locale): RegistryText {
  return { locale, r: translatorFor(locale, "sourcesRegistry"), cli: translatorFor(locale, "cli.sourcesList") };
}

const ERROR_CODES = ["rate_limited", "blocked", "auth_expired", "budget_exceeded", "network", "parse", "not_found", "unknown"] as const;
type ErrorCode = (typeof ERROR_CODES)[number];
const isErrorCode = (code: string): code is ErrorCode => (ERROR_CODES as readonly string[]).includes(code);
const RUN_RESULTS = ["succeeded", "partial", "interrupted", "failed", "skipped", "running"] as const;
type RunResult = (typeof RUN_RESULTS)[number];
const isRunResult = (code: string): code is RunResult => (RUN_RESULTS as readonly string[]).includes(code);

/** An error code in words; an unknown code as it is. */
export const errorLabel = (code: string, text: RegistryText): string => (isErrorCode(code) ? text.r(`errorCode.${code}`) : code);

/** A status in words (`failing` → `Failing` in English). */
export const statusLabel = (status: RegistryStatus, text: RegistryText): string => text.r(`status.${status}`);

/** `MM-DD HH:mm` of an instant in `timeZone`. */
export function shortTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "??";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
}

/** `YYYY-MM-DD HH:mm` of an instant in `timeZone`. */
export function fullTime(iso: string, timeZone: string): string {
  const year = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric" }).format(new Date(iso));
  return `${year}-${shortTime(iso, timeZone)}`;
}

/** One reason in words. Only environment variable names appear, never values (C4). */
export function reasonText(reason: RegistryReason, timeZone: string, text: RegistryText): string {
  const { r } = text;
  const v = reason.values ?? {};
  const error = (): string => errorLabel(String(v.error ?? "unknown"), text);
  switch (reason.key) {
    case "offChannel":
      return r("reason.offChannel");
    case "otherMarket":
      return r("reason.otherMarket", { markets: String(v.markets ?? "") });
    case "offBoard":
      return r("reason.offBoard");
    case "parentOff":
      return r("reason.parentOff", { channel: String(v.channel ?? "") });
    case "noRuns":
      return r("reason.noRuns");
    case "notRegistered":
      return r("reason.notRegistered");
    case "lastRunFailed":
      return r("reason.lastRunFailed", { error: error() });
    case "consecutive":
      return r("reason.consecutive", { count: Number(v.count ?? 0) });
    case "circuitUntil":
      return r("reason.circuitUntil", { when: reason.at ? shortTime(reason.at, timeZone) : "?" });
    case "halfOpen":
      return r("reason.halfOpen");
    case "requestFailures":
      return r("reason.requestFailures");
    case "skipped":
      return r("reason.skipped", { count: Number(v.count ?? 0), error: error() });
    case "cascadeStandby":
      return r("reason.cascadeStandby");
    case "missingEnv":
      return r("reason.missingEnv", { names: String(v.names ?? "") });
    case "loginMissing":
      return r("reason.loginMissing");
    case "loginExpired":
      return r("reason.loginExpired");
    case "missingApify":
      return r("reason.missingApify");
    case "missingMonid":
      return r("reason.missingMonid");
    case "notConfigured":
      return r("reason.notConfigured");
    case "neverChecked":
      return r("reason.neverChecked");
    case "boardFailing":
      return r("reason.boardFailing", { count: Number(v.count ?? 0), error: error() });
    case "boardFailedOnce":
      return r("reason.boardFailedOnce", { error: error() });
    case "boardStale":
      return r("reason.boardStale", { hours: Number(v.hours ?? 0) });
  }
}

export const reasonsText = (reasons: readonly RegistryReason[], timeZone: string, text: RegistryText): string =>
  reasons.length === 0 ? "—" : reasons.map((r) => reasonText(r, timeZone, text)).join(" · ");

export interface RemovedEntry {
  id: string;
  type: "channel" | "ats_board";
  name: string;
  removedAt: string | null;
}

export interface CliRow {
  id: string;
  type: "channel" | "ats_board";
  group: string;
  name: string;
  enabled: boolean;
  /** `null` = unknown (the database was not reachable) or removed. */
  status: RegistryStatus | "unknown" | "removed";
  /** The reasons as codes (machine-readable, in `--json`). */
  reasons: RegistryReason[];
  /** The reasons in words (the table). */
  reason: string;
  lastRunAt: string | null;
  /** A code: `succeeded` | `partial` | `failed` | `skipped` | `running` (channels), `ok` | `not_modified` | `error` (boards). */
  lastRunResult: string | null;
  /** `lastRunResult` in words (the table). */
  lastRunLabel: string | null;
  lastSuccessAt: string | null;
  /** Channels: fetched / new in the window. Boards: postings seen in the window. */
  windowFetched: number | null;
  windowNew: number | null;
}

/** The last run's result; a run whose query was cut short after some pages reads `interrupted` rather than `partial`. */
const lastRunResult = (run: ChannelRow["lastRun"]): string | null => (run ? (run.interrupted ? "interrupted" : run.status) : null);

function channelRow(row: ChannelRow, timeZone: string, text: RegistryText): CliRow {
  const result = lastRunResult(row.lastRun);
  return {
    id: row.id,
    type: "channel",
    group: row.group,
    name: row.name,
    enabled: row.enabled,
    status: row.status,
    reasons: row.reasons,
    reason: reasonsText(row.reasons, timeZone, text),
    lastRunAt: row.lastRun?.at ?? null,
    lastRunResult: result,
    lastRunLabel: result === null ? null : isRunResult(result) ? text.r(`run.${result}`) : result,
    lastSuccessAt: row.lastSuccessAt,
    windowFetched: row.window.fetched,
    windowNew: row.window.newCount,
  };
}

function boardRow(row: BoardRow, timeZone: string, text: RegistryText): CliRow {
  return {
    id: row.id,
    type: "ats_board",
    group: row.group,
    name: row.name,
    enabled: row.enabled,
    status: row.status,
    reasons: row.reasons,
    reason: reasonsText(row.reasons, timeZone, text),
    lastRunAt: row.lastCheck?.at ?? null,
    lastRunResult: row.lastCheck?.status ?? null,
    lastRunLabel: row.lastCheck ? text.r(`check.${row.lastCheck.status}`) : null,
    lastSuccessAt: row.lastOkAt,
    windowFetched: row.seen,
    windowNew: null,
  };
}

export interface CliFilter {
  type: "channel" | "ats_board" | null;
  statuses: readonly RegistryStatus[];
}

/** The rows of the report: filtered by type and status, failing first. */
export function cliRows(view: RegistryView, filter: CliFilter, timeZone: string, text: RegistryText): CliRow[] {
  const rows = [...view.channels.map((r) => channelRow(r, timeZone, text)), ...view.boards.map((r) => boardRow(r, timeZone, text))];
  return rows.filter((r) => (filter.type === null || r.type === filter.type) && (filter.statuses.length === 0 || (r.status !== "unknown" && r.status !== "removed" && filter.statuses.includes(r.status))));
}

/** Rows for a run without a database: the entries of the file, health unknown. */
export function unknownRows(rows: readonly { id: string; type: "channel" | "ats_board"; group: string; name: string; enabled: boolean }[], text: RegistryText): CliRow[] {
  return rows.map((r) => ({ ...r, status: "unknown", reasons: [], reason: text.cli("dbDown"), lastRunAt: null, lastRunResult: null, lastRunLabel: null, lastSuccessAt: null, windowFetched: null, windowNew: null }));
}

export function removedRows(removed: readonly RemovedEntry[], timeZone: string, text: RegistryText): CliRow[] {
  return removed.map((r) => ({
    id: r.id,
    type: r.type,
    group: "",
    name: r.name,
    enabled: false,
    status: "removed",
    reasons: [],
    reason: r.removedAt ? text.cli("removedFromFileAt", { time: fullTime(r.removedAt, timeZone) }) : text.cli("removedFromFile"),
    lastRunAt: null,
    lastRunResult: null,
    lastRunLabel: null,
    lastSuccessAt: null,
    windowFetched: null,
    windowNew: null,
  }));
}

const SEVERITY: Record<string, number> = { failing: 0, degraded: 1, never_run: 2, ok: 3, standby: 4, not_configured: 5, off: 6, unknown: 7, removed: 8 };

/** Failing first, then by id; keeps the file order inside a status otherwise. */
export function sortCliRows(rows: readonly CliRow[]): CliRow[] {
  return rows.map((row, index) => ({ row, index })).sort((a, b) => (SEVERITY[a.row.status] ?? 9) - (SEVERITY[b.row.status] ?? 9) || a.index - b.index).map((x) => x.row);
}

/** An enabled source in the failing state: what `--strict` exits non-zero for. */
export function hasFailingEnabled(rows: readonly CliRow[]): boolean {
  return rows.some((r) => r.enabled && r.status === "failing");
}

/** Terminal width of a string: CJK characters take two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return width;
}

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - displayWidth(text)));

export interface TextReportInput {
  rows: readonly CliRow[];
  /** The `registry.window_days` of the fetched / new column. */
  windowDays: number;
  timeZone: string;
  fileLabel: string;
  /** Entries of the file (all, before filtering). */
  total: number;
  counts: Record<RegistryStatus, number> | null;
  mirror: { syncedAt: string | null; inSync: boolean } | null;
}

export function renderRegistryText(input: TextReportInput, text: RegistryText): string {
  const { cli } = text;
  const mirror =
    input.mirror === null
      ? cli("mirrorDbDown")
      : input.mirror.syncedAt === null
        ? cli("mirrorNever")
        : input.mirror.inSync
          ? cli("mirrorSynced", { time: fullTime(input.mirror.syncedAt, input.timeZone) })
          : cli("mirrorStale", { time: fullTime(input.mirror.syncedAt, input.timeZone) });
  const lines = [cli("heading", { file: input.fileLabel, total: input.total, mirror })];
  const header = [cli("colStatus"), "id", cli("colType"), cli("colEnabled"), cli("colLastRun"), cli("colLastSuccess"), cli("colWindow", { days: input.windowDays }), cli("colReason")];
  const table = input.rows.map((r) => [
    r.status === "unknown" ? cli("unknown") : r.status === "removed" ? cli("removed") : statusLabel(r.status, text),
    r.id,
    r.type === "channel" ? cli("typeChannel") : cli("typeBoard"),
    r.enabled ? cli("yes") : cli("no"),
    r.lastRunAt ? `${shortTime(r.lastRunAt, input.timeZone)} ${r.lastRunLabel ?? ""}`.trim() : "—",
    r.lastSuccessAt ? shortTime(r.lastSuccessAt, input.timeZone) : "—",
    r.windowFetched === null ? "—" : r.windowNew === null ? String(r.windowFetched) : `${r.windowFetched}/${r.windowNew}`,
    r.reason,
  ]);
  const widths = header.map((h, i) => Math.max(displayWidth(h), ...table.map((row) => displayWidth(row[i] ?? ""))));
  const render = (cells: readonly string[]): string => cells.map((c, i) => (i === cells.length - 1 ? c : pad(c, (widths[i] ?? 0) + 2))).join("").trimEnd();
  lines.push(render(header), ...table.map(render));
  if (input.counts) {
    lines.push(cli("summary", { counts: REGISTRY_STATUSES.map((s) => `${statusLabel(s, text)} ${input.counts?.[s] ?? 0}`).join(" · ") }));
  } else {
    lines.push(cli("summaryDbDown"));
  }
  return lines.join("\n");
}

export function renderRegistryJson(input: TextReportInput & { generatedAt: string }): string {
  return JSON.stringify(
    {
      file: input.fileLabel,
      generatedAt: input.generatedAt,
      total: input.total,
      mirror: input.mirror,
      counts: input.counts,
      entries: input.rows.map((r) => ({
        id: r.id,
        type: r.type,
        group: r.group,
        name: r.name,
        enabled: r.enabled,
        status: r.status,
        reasons: r.reasons,
        lastRunAt: r.lastRunAt,
        lastRunResult: r.lastRunResult,
        lastSuccessAt: r.lastSuccessAt,
        windowFetched: r.windowFetched,
        windowNew: r.windowNew,
      })),
    },
    null,
    2,
  );
}
