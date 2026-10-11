import { useFormatter, useTranslations } from "next-intl";

import { COMPACT_OPTIONS, formatUsdAmount, isCompact } from "@/lib/format/numbers";
import { cn } from "@/lib/utils";

/** An unknown value: a dashed box that says so, never a 0 (C3). */
export function Unknown({ className }: { className?: string }) {
  const t = useTranslations("aiUsage");
  return (
    <span data-unknown className={cn("text-ink-2 border-ink-3 rounded-tag text-data-sm inline-block border-[1.5px] border-dashed px-1.5 font-sans leading-snug whitespace-nowrap", className)}>
      {t("unknown")}
    </span>
  );
}

/**
 * `1,800 / 500`: the first number must be known (else the whole cell is unknown); a missing second one is a dash.
 * For a sum over several calls, `partUnknown` is how many of the `main` calls did not report the sub-count (old rows):
 * the known sum is shown with "N unknown" next to it, or just "unknown" when none reported it (C3: never a 0).
 */
export function Tokens({ main, part, partUnknown = 0, partTotal = 0 }: { main: number | null; part: number | null; partUnknown?: number; partTotal?: number }) {
  const format = useFormatter();
  const t = useTranslations("aiUsage");
  if (main === null) return <Unknown />;
  const allUnknown = partUnknown > 0 && partUnknown >= partTotal;
  return (
    <span className="font-mono tabular-nums whitespace-nowrap" data-tokens={main} {...(partUnknown > 0 ? { "data-part-unknown": partUnknown } : {})}>
      {format.number(main)} /{" "}
      {part === null ? (
        <span className="text-ink-2" title={t("unknown")}>
          —
        </span>
      ) : allUnknown ? (
        <span className="text-ink-2 font-sans" data-unknown>
          {t("unknown")}
        </span>
      ) : (
        <>
          {format.number(part)}
          {partUnknown > 0 ? <span className="text-ink-2 text-data-sm font-sans"> · {t("partUnknown", { count: format.number(partUnknown) })}</span> : null}
        </>
      )}
    </span>
  );
}

/** USD as `$0.0287`, shared by the cells and the chart axis (see `formatUsdAmount`). */
export function useUsdText(): (value: number) => string {
  const format = useFormatter();
  return (value) => formatUsdAmount(format, value);
}

/** USD: `$0.0287`; sub-dollar amounts keep four decimals so small AI costs do not all read as $0.00. */
export function Usd({ value, className, compact = false }: { value: number | null; className?: string; compact?: boolean }) {
  const format = useFormatter();
  if (value === null) return <Unknown />;
  const text = formatUsdAmount(format, value);
  // headline tiles: a 7-digit amount is written `$1.95M`, the exact amount stays in the title
  const short = compact && isCompact(value);
  return (
    <span className={cn("font-mono tabular-nums whitespace-nowrap", className)} data-usd={value} {...(short ? { title: text, "data-compact": "true" } : {})}>
      {short ? `$${format.number(value, COMPACT_OPTIONS)}` : text}
    </span>
  );
}

/** `8.2 s`, `< 1 s`, `1 m 05 s`; null (legacy rows) is a dash. */
export function Duration({ ms }: { ms: number | null }) {
  const format = useFormatter();
  if (ms === null) return <span className="text-ink-2">—</span>;
  if (ms < 1000) return <span className="font-mono tabular-nums whitespace-nowrap">&lt; 1 s</span>;
  const text = ms >= 60_000 ? `${Math.floor(ms / 60_000)} m ${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")} s` : `${format.number(ms / 1000, { maximumFractionDigits: 1, minimumFractionDigits: 1 })} s`;
  return <span className="font-mono tabular-nums whitespace-nowrap">{text}</span>;
}

/**
 * `provider · Display name` with the model id under it in mono. `cli_default` and `assumed` get a small tag; no model at
 * all is "unknown model" (a dashed tag).
 */
export function ModelName({ provider, model, label, source, showProvider = true }: { provider: string | null; model: string | null; label: string | null; source: string | null; showProvider?: boolean }) {
  const t = useTranslations("aiUsage.breakdown");
  return (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {showProvider && provider ? <span className="font-mono text-data font-bold">{provider}</span> : null}
        {model === null ? (
          <span data-unknown className="text-ink-2 border-ink-3 rounded-tag text-data-sm border-[1.5px] border-dashed px-1.5 leading-snug">
            {t("unknownModel")}
          </span>
        ) : (
          <>
            {showProvider && provider ? <span aria-hidden>·</span> : null}
            <span className="font-semibold">{label ?? model}</span>
          </>
        )}
        {source === "cli_default" ? <span className="bg-soft border-border rounded-tag text-data-sm border-[1.5px] px-1.5 leading-snug font-bold">{t("cliDefault")}</span> : null}
        {source === "assumed" ? <span className="text-ink border-ink-3 rounded-tag text-data-sm border-[1.5px] border-dashed px-1.5 leading-snug font-bold">{t("assumed")}</span> : null}
      </span>
      {model !== null && label !== null && label !== model ? <span className="text-ink-2 text-data-sm font-mono break-all">{model}</span> : null}
    </span>
  );
}
