import { formatDuration as formatDurationMs } from "@/lib/format/time";

import type { CheckGroup, CheckOutcome, CheckStatus, DoctorContext } from "./types";

export const STATUS_ORDER: Record<CheckStatus, number> = { ok: 0, warn: 1, fail: 2 };

export function worstOf(statuses: readonly CheckStatus[]): CheckStatus {
  return statuses.reduce<CheckStatus>((worst, status) => (STATUS_ORDER[status] > STATUS_ORDER[worst] ? status : worst), "ok");
}

/** Id and group of a result; `title` only where it is not `doctor.checks.<id>.title` (a per-channel or per-service result). */
export interface Spec {
  id: string;
  group: CheckGroup;
  title?: string;
}

export function ok(spec: Spec, detail: string): CheckOutcome {
  return { ...spec, status: "ok", detail };
}

export function warn(spec: Spec, detail: string, hint: string): CheckOutcome {
  return { ...spec, status: "warn", detail, hint };
}

export function fail(spec: Spec, detail: string, hint: string): CheckOutcome {
  return { ...spec, status: "fail", detail, hint };
}

/** One finding of a check that looks at several things; `merge` folds them into one result. */
export interface Piece {
  status: CheckStatus;
  detail: string;
  hint?: string;
}

/** The worst finding decides the status; all details are shown, the hints of the non-ok findings are joined. */
export function merge(ctx: DoctorContext, spec: Spec, pieces: readonly Piece[]): CheckOutcome {
  const status = worstOf(pieces.map((p) => p.status));
  const hints = pieces.filter((p) => p.status !== "ok" && p.hint !== undefined).map((p) => p.hint as string);
  const result: CheckOutcome = { ...spec, status, detail: pieces.map((p) => p.detail).join(ctx.t("common.detailSeparator")) };
  if (status !== "ok" && hints.length > 0) result.hint = hints.join(" / ");
  return result;
}

/** A duration of `seconds` in the report's language (`format.duration`: `45 s`, `3 h 20 min`, `2 d 4 h`). */
export function formatDuration(ctx: DoctorContext, seconds: number): string {
  return formatDurationMs(Math.max(0, Math.round(seconds)) * 1000, ctx.locale);
}

/** `<duration> ago` in the report's language. */
export function formatAgo(ctx: DoctorContext, seconds: number): string {
  return ctx.t("common.ago", { duration: formatDuration(ctx, seconds) });
}

/** Items of a list joined in the report's language (`、` / `, `). */
export function joinList(ctx: DoctorContext, items: readonly string[]): string {
  return items.join(ctx.t("common.listSeparator"));
}

export function ageSeconds(from: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Strip anything that looks like a URL with credentials, or a bearer token, before an error text is shown (C4). */
export function redact(text: string): string {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi, "$1***@")
    .replace(/(bot)\d+:[\w-]+/gi, "$1***")
    .replace(/\b(Bearer|Token)\s+[\w.~+/=-]+/gi, "$1 ***")
    .slice(0, 300);
}

/** `a / b` budgets as a ratio; null when there is no budget to compare against. */
export function ratio(used: number, limit: number): number | null {
  return limit > 0 ? used / limit : null;
}

const memo = new WeakMap<DoctorContext, Map<string, Promise<unknown>>>();

/** Run `load` once per doctor run and share the answer between checks (docker, tailscale, the sources view ...). */
export function cached<T>(ctx: DoctorContext, key: string, load: () => Promise<T>): Promise<T> {
  let entries = memo.get(ctx);
  if (!entries) {
    entries = new Map();
    memo.set(ctx, entries);
  }
  const hit = entries.get(key);
  if (hit) return hit as Promise<T>;
  const pending = load();
  entries.set(key, pending);
  return pending;
}

/** First `{` ... last `}` of a text: CLIs print version warnings around their JSON. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** "2026-10-07 17:01": wall clock in `timeZone` (the schedule's), without the zone name. */
export function formatLocal(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
}
