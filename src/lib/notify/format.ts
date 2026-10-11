import type { PushCandidate } from "@/lib/db/repos/notifications";
import type { SignalCatalog } from "@/lib/signals/catalog";
import { loadSignalCatalog } from "@/lib/signals/floor";
import { isGermanRequirement, type JobSalary } from "@/lib/domain/types";
import { localLanguageName } from "@/lib/market/view";
import type { StaleApplication } from "@/lib/db/repos/applications";

import { isStatusOffered } from "@/lib/applications/visibility";
import { currencyPrefix } from "@/lib/format/numbers";

import { ACTION_RULES, encodeCallback } from "./callbacks";
import type { PushItem } from "./select";
import type { InlineKeyboard } from "./telegram-client";
import { pickSummary, summaryOrder } from "@/lib/dashboard/summary";

import type { NotifyText } from "./text";
import { formatLocalShort } from "./time";
import { trapsTranslator } from "@/lib/traps/text";

/**
 * Message layout. Parse mode is HTML, not MarkdownV2: HTML only has to escape `& < >` (and `"` in
 * attribute values), while MarkdownV2 requires escaping eighteen characters in text and a different
 * set inside links and code, and a single missed `.` or `-` makes Telegram reject the whole message.
 * Job titles and company names are free text from the web, so the simpler rule is the safer one.
 */

/** Telegram rejects messages longer than 4096 characters. */
export const MAX_MESSAGE_CHARS = 4096;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** For text inside an attribute value (`href="..."`). */
export function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

/** Longest URL put in a link; a longer one (tracking junk) could push a message over the 4096-character limit. */
const MAX_URL_CHARS = 1000;

/** A link; the label and URL are escaped, a URL that is not http(s) (or is absurdly long) falls back to the plain label. */
export function link(label: string, url: string): string {
  return /^https?:\/\//i.test(url) && url.length <= MAX_URL_CHARS ? `<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

/** Cut `text` to `max` characters (code points), adding an ellipsis. Never splits a surrogate pair. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, Math.max(0, max - 1)).join("").trimEnd()}…`;
}

/** Collapse whitespace so a title / summary stays on one line. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function num(value: number): string {
  return String(Number(value.toFixed(1)));
}

/** The name of a cycle kind (`telegram.cycleKind.*`); an unknown kind is shown as it is. */
export function cycleLabel(kind: string, text: NotifyText): string {
  const key = `cycleKind.${kind}` as "cycleKind.manual";
  return text.t.has(key) ? text.t(key) : kind;
}

/**
 * Join `lines`, dropping whole lines from the end until the text fits in one message (cutting
 * mid-line could leave an HTML tag open, which Telegram rejects). `note` ends a shortened message.
 */
export function fitLines(lines: readonly string[], note: string, max = MAX_MESSAGE_CHARS): string {
  const kept = [...lines];
  while (kept.length > 1 && kept.join("\n").length > max - note.length - 1) kept.pop();
  const text = kept.join("\n");
  return kept.length < lines.length ? `${text}\n${note}` : text;
}

// ---------------------------------------------------------------- job message


/** 85000 → "85", 87500 → "87.5" (thousands, one decimal at most). */
function thousands(value: number): string {
  return String(Number((value / 1000).toFixed(1)));
}

/**
 * The normalized yearly range for the 💰 badge, e.g. "€85–105k", "≤ €120k", "€90k". Prefers the figure in the base
 * currency, else the posting's own currency; null when there is no usable range (C3: nothing is guessed).
 */
export function salaryRangeText(salary: JobSalary | null): string | null {
  if (!salary || salary.qualityStatus === "review") return null;
  const base = salary.baseCurrency !== null ? salary.basePerYear : null;
  const range = base ?? salary.perYear;
  const currency = base ? (salary.baseCurrency ?? "") : (salary.currency ?? "");
  if (!range || (range.min == null && range.max == null) || currency === "") return null;
  const symbol = currencyPrefix(currency);
  if (range.min != null && range.max != null) {
    return range.min === range.max ? `${symbol}${thousands(range.min)}k` : `${symbol}${thousands(range.min)}–${thousands(range.max)}k`;
  }
  return range.max != null ? `≤ ${symbol}${thousands(range.max)}k` : `≥ ${symbol}${thousands(range.min as number)}k`;
}

/**
 * Badges, one per active signal category the job has, in category order: the amount category as its icon and the
 * normalized range ("💰 €85–105k"), every other one as icon + name ("📈 Equity"; the category's name in the Telegram
 * language, another one when it has none), then 👀 for a watched company; an AI trap comes first. Tag categories are not
 * badges. `options.catalog` defaults to the current interests.yaml.
 */
export function badgesOf(item: Pick<PushItem, "candidate" | "watched">, text: NotifyText, options: { traps?: boolean; catalog?: SignalCatalog | null } = {}): string[] {
  const catalog = options.catalog === undefined ? loadSignalCatalog() : options.catalog;
  const ids = new Set(item.candidate.signalTiers);
  const badges: string[] = [];
  // An AI trap comes first (text from messages: aiTraps.telegram)
  const trapCount = item.candidate.trapCount ?? 0;
  if (options.traps && trapCount > 0) badges.push(trapsTranslator(text.locale)("telegram.badge", { count: trapCount }));
  for (const category of catalog?.categories ?? []) {
    if (!ids.has(category.id) || category.kind === "tag") continue;
    const label = catalog?.labelOf(category.id, text.locale) ?? category.id;
    if (category.kind === "amount") {
      const range = salaryRangeText(item.candidate.salary);
      const badge = range === null ? (category.icon ?? label) : [category.icon, range].filter((p): p is string => p !== undefined).join(" ");
      // A USD range on a Berlin job is usually another office's pay; say so instead of letting it read as local
      badges.push(item.candidate.salary?.otherRegion ? text.t("job.otherRegion", { range: badge }) : badge);
    } else {
      badges.push([category.icon, label].filter((p): p is string => p !== undefined).join(" "));
    }
  }
  if (item.watched) badges.push(text.t("job.watched"));
  return badges;
}

/** "German B2 required": the market's local language (named in the Telegram language) and the level; none while the language step is off. */
function languageBadge(level: string, languageName: string | null, text: NotifyText): string | null {
  return languageName !== null && isGermanRequirement(level) ? text.t("job.languageRequired", { language: languageName, level }) : null;
}

const WORKPLACE_LABELS: Record<PushCandidate["workplace"], string | null> = { remote: "Remote", hybrid: "Hybrid", onsite: null, unknown: null };

function whereOf(candidate: PushCandidate): string {
  const cities = candidate.locations.slice(0, 3);
  const extra = candidate.locations.length > cities.length ? ` +${candidate.locations.length - cities.length}` : "";
  const workplace = WORKPLACE_LABELS[candidate.workplace];
  return [cities.length > 0 ? `${cities.join(" / ")}${extra}` : null, workplace].filter((p): p is string => p !== null).join(" · ");
}

export interface JobMessageOptions {
  /** `notify.yaml: public_base_url`; the "open details" link is `<base>/jobs/<id>`. */
  publicBaseUrl: string | null;
  /** Appended below the text once a button was pressed (the keyboard is then dropped). */
  markedLine?: string;
  /** Show the AI trap badge (traps.yaml `enabled`); default off. */
  traps?: boolean;
  /** The signal categories the badges use; default: the current interests.yaml. */
  catalog?: SignalCatalog | null;
  /** The local language as the message names it ("德语"), null = the language step is off; default: the current market's. */
  languageName?: string | null;
}

export function detailUrl(baseUrl: string, jobId: number): string {
  return `${baseUrl.replace(/\/+$/, "")}/jobs/${jobId}`;
}

export function formatJobMessage(item: PushItem, text: NotifyText, options: JobMessageOptions): string {
  const { candidate } = item;
  const { t } = text;
  const score = candidate.score;
  const fit =
    score && score.score !== null ? (score.signalBonus > 0 ? t("job.fitWithSignals", { score: num(score.score), bonus: num(score.signalBonus) }) : t("job.fit", { score: num(score.score) })) : null;
  const rankText = item.rank === null ? `<b>${escapeHtml(t("job.unscored"))}</b>` : `<b>🎯 ${num(item.rank)}</b>` + (fit === null ? "" : ` <i>${escapeHtml(fit)}</i>`);
  const languageName = options.languageName === undefined ? localLanguageName(text.locale) : options.languageName;
  const badges = [...badgesOf(item, text, { traps: options.traps === true, ...(options.catalog === undefined ? {} : { catalog: options.catalog }) }), ...[languageBadge(candidate.germanLevelRequired, languageName, text)].filter((b): b is string => b !== null)];
  const badgeText = badges.join(" · ");

  const lines = [
    [rankText, badgeText].filter((p) => p.length > 0).join("  "),
    `<b>${escapeHtml(truncate(oneLine(candidate.title), 150))}</b>`,
    [escapeHtml(truncate(oneLine(candidate.companyName), 80)), escapeHtml(whereOf(candidate))].filter((p) => p.length > 0).join(" · "),
  ];
  // The summary in the Telegram language, else the AI's output language, else English, else any
  const picked = score ? pickSummary(score.summaries, summaryOrder(text.locale, score.outputLang)) : null;
  const summary = picked ? oneLine(picked.text) : "";
  if (summary.length > 0) lines.push(escapeHtml(truncate(summary, 300)));

  const links: string[] = [];
  if (options.publicBaseUrl) links.push(link(t("job.openDetails"), detailUrl(options.publicBaseUrl, candidate.jobId)));
  if (candidate.sourceUrl) links.push(link(t("job.source"), candidate.sourceUrl));
  if (links.length > 0) lines.push(links.join(" · "));
  if (options.markedLine) lines.push("", escapeHtml(options.markedLine));
  return lines.join("\n");
}

/**
 * Two rows: the status buttons (👍 🚫 📄), then the star (⭐ save, or ☆ unsave once starred). A status button removes the
 * keyboard; the star button does not.
 */
export function jobKeyboard(
  jobId: number,
  text: NotifyText,
  { favorite = false, hiddenStatuses = [], resumeKit = true }: { favorite?: boolean; hiddenStatuses?: readonly string[]; resumeKit?: boolean } = {},
): InlineKeyboard {
  const { t } = text;
  // A button whose target status is hidden in ui.yaml is not offered (an old message still works: the server accepts the press)
  const statusRow = [
    ...(isStatusOffered(ACTION_RULES.interested.to, hiddenStatuses) ? [{ text: t("button.interested"), callback_data: encodeCallback(jobId, "interested") }] : []),
    { text: t("button.ignore"), callback_data: encodeCallback(jobId, "ignore") },
    // the résumé button needs a configured resume-kit folder; without one the command it produces cannot be built
    ...(resumeKit && isStatusOffered(ACTION_RULES.resume.to, hiddenStatuses) ? [{ text: t("button.resume"), callback_data: encodeCallback(jobId, "resume") }] : []),
  ];
  return {
    inline_keyboard: [
      statusRow,
      [favorite ? { text: t("button.unfavorite"), callback_data: encodeCallback(jobId, "unfavorite") } : { text: t("button.favorite"), callback_data: encodeCallback(jobId, "favorite") }],
    ],
  };
}

/** After a status button press the buttons go away. */
export const EMPTY_KEYBOARD: InlineKeyboard = { inline_keyboard: [] };

// ---------------------------------------------------------------- cycle summary

export interface SummaryInput {
  cycleKind: string;
  at: Date;
  timeZone: string;
  newJobs: number;
  passedFilter: number;
  qualified: number;
  pushed: number;
  /** Eligible jobs not pushed because of `max_per_cycle`. */
  overflow: number;
  failedSources: Array<{ channelId: string; reasons: string[] }>;
  publicBaseUrl: string | null;
}

export function formatSummary(input: SummaryInput, text: NotifyText): string {
  const { t } = text;
  const lines = [
    `<b>📡 ${escapeHtml(cycleLabel(input.cycleKind, text))} · ${escapeHtml(formatLocalShort(input.at, input.timeZone))}</b>`,
    escapeHtml(t("summary.counts", { newJobs: input.newJobs, passed: input.passedFilter, qualified: input.qualified, pushed: input.pushed })),
  ];
  if (input.overflow > 0) lines.push(escapeHtml(t("summary.overflow", { count: input.overflow })));
  if (input.failedSources.length > 0) {
    const sources = input.failedSources
      .map((s) => (s.reasons.length > 0 ? t("summary.failedSource", { source: s.channelId, reasons: s.reasons.join(t("summary.reasonSeparator")) }) : s.channelId))
      .join(t("summary.sourceSeparator"));
    lines.push(escapeHtml(t("summary.failedSources", { sources })));
  }
  if (input.publicBaseUrl) lines.push(link(t("summary.openBoard"), input.publicBaseUrl));
  return lines.join("\n");
}

// ---------------------------------------------------------------- alerts

export function formatAlert(title: string, detail: string): string {
  return `🚨 <b>${escapeHtml(title)}</b>\n${escapeHtml(detail)}`;
}

// ---------------------------------------------------------------- reminders

export interface ReminderSection {
  heading: string;
  total: number;
  items: StaleApplication[];
}

const DAY_MS = 86_400_000;

/** Markup of a message: `<b>` stays bold, the arguments are inserted as given (escape them first). */
const MARKUP_TAGS = { b: (chunks: string) => `<b>${chunks}</b>` };

export function formatReminders(input: { sections: ReminderSection[]; now: Date; publicBaseUrl: string | null }, text: NotifyText): string {
  const { t } = text;
  const lines = [`<b>${escapeHtml(t("reminders.title"))}</b>`];
  for (const section of input.sections) {
    if (section.total === 0) continue;
    lines.push("", t.markup("reminders.section", { ...MARKUP_TAGS, heading: escapeHtml(section.heading), count: section.total }));
    for (const item of section.items) {
      const days = Math.max(0, Math.floor((input.now.getTime() - item.statusChangedAt.getTime()) / DAY_MS));
      const title = escapeHtml(truncate(oneLine(item.title), 80));
      const label = input.publicBaseUrl ? link(truncate(oneLine(item.title), 80), detailUrl(input.publicBaseUrl, item.jobId)) : title;
      lines.push(t.markup("reminders.item", { ...MARKUP_TAGS, title: label, company: escapeHtml(truncate(oneLine(item.companyName), 50)), days }));
    }
    if (section.total > section.items.length) lines.push(escapeHtml(t("reminders.more", { count: section.total - section.items.length })));
  }
  return fitLines(lines, t("omitted"));
}
