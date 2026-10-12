"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import type { ReasonSourceView } from "@/lib/dashboard/reason-evidence";
import { cn } from "@/lib/utils";

import { requestJdJump } from "./marks";

/** The marker's shape carries the meaning as much as its word: solid = in the JD, outlined = inferred, dashed = not stated. */
const MARKER = "mr-1.5 inline-flex min-h-sp-6 items-center rounded-tag border-bw px-1.5 align-middle font-mono text-data-sm font-bold leading-none whitespace-nowrap";
const MARKER_CLASS = {
  jd: "press cursor-pointer border-ink bg-ink text-paper",
  inferred: "border-border bg-card text-ink-2",
  unstated: "border-dashed border-ink-3 bg-transparent text-ink-3",
} as const;

interface ReasonSourceProps {
  /** The reason or gap as the AI wrote it. */
  text: string;
  /** Its source; null (or a source without a basis) shows the text alone. */
  source: ReasonSourceView | null;
  /** Whether the JD panel shows the quote's mark: only then "View in the original" is offered. */
  jumpable: boolean;
  /** The JD's language (`lang` of the quote); undefined when unknown. */
  quoteLang?: string | undefined;
}

/**
 * One fit reason or gap with the marker of its source. "JD" opens the verbatim quote (external text, rendered as text only) and
 * "View in the original", which jumps to the quote's mark in the JD panel; "Inferred" and "Not stated" explain themselves on hover.
 */
export function ReasonSource({ text, source, jumpable, quoteLang }: ReasonSourceProps) {
  const t = useTranslations("scoreEvidence");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const id = useId();
  const basis = source?.basis ?? null;
  if (basis === null) return <span data-testid="reason-text">{text}</span>;
  const label = t(`basis.${basis}`);
  const hint = t(`hint.${basis}`);

  if (basis !== "jd" || source?.quote == null) {
    return (
      <span data-testid="reason-text" data-basis={basis}>
        <span lang={locale} title={hint} className={cn(MARKER, MARKER_CLASS[basis === "unstated" ? "unstated" : "inferred"])} data-testid="reason-source" data-basis={basis}>
          {label}
          <span className="sr-only">: {hint}</span>
        </span>
        {text}
      </span>
    );
  }

  const quote = source.quote;
  return (
    <div className="flex min-w-0 flex-col gap-1.5" data-testid="reason-text" data-basis="jd">
      <div>
        <button
          type="button"
          lang={locale}
          aria-expanded={open}
          aria-controls={id}
          title={open ? t("hideQuote") : t("showQuote")}
          onClick={() => setOpen((value) => !value)}
          className={cn(MARKER, MARKER_CLASS.jd)}
          data-testid="reason-source"
          data-basis="jd"
        >
          {label}
          <span className="sr-only">: {open ? t("hideQuote") : t("showQuote")}</span>
        </button>
        {text}
      </div>
      <div id={id} hidden={!open} className={cn(open ? "flex" : "hidden", "min-w-0 flex-col items-start gap-1.5")} data-testid="reason-quote-box">
        <blockquote lang={quoteLang} className="border-border text-ink-2 rounded-cell border-bw w-full border-dashed px-2 py-1 font-mono text-data [overflow-wrap:anywhere]" data-testid="reason-quote">
          <span lang={locale} className="text-ink-3">{t("quoteLabel")}: </span>“{quote}”
        </blockquote>
        {jumpable && source.mark !== null ? (
          <Button type="button" variant="outline" size="sm" onClick={() => requestJdJump(source.mark as number)} data-testid="reason-jump">
            {t("viewInJd")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
