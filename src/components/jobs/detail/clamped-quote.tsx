"use client";

import { useId, useState } from "react";

import { INK_LINK } from "@/components/ui/ink-link";
import { QUOTE_CLAMP_CHARS, QUOTE_CLAMP_LEAD_CHARS } from "@/lib/dashboard/limits";
import { fitsWhole, quoteWindow, type QuoteTerm } from "@/lib/dashboard/quote-window";
import type { SignalColor } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

import { markClass } from "./marks";

interface ClampedQuoteProps {
  /** C7: the verbatim JD quote. */
  text: string;
  /** Where the term that makes it a signal stands in `text`; null when unknown. */
  term: QuoteTerm | null;
  /** Colour of the term's highlight (the signal category's). */
  color: SignalColor;
  lang?: string | undefined;
  className?: string;
  expandLabel: string;
  collapseLabel: string;
  /** Small text before the opening quote mark ("Original:"). */
  label?: string;
  testId?: string;
}

function Marked({ text, term, color, from }: { text: string; term: QuoteTerm | null; color: SignalColor; from: number }) {
  if (term === null) return <>{text}</>;
  const start = Math.max(0, term.start - from);
  const end = Math.min(text.length, term.end - from);
  if (start >= end) return <>{text}</>;
  return (
    <>
      {text.slice(0, start)}
      <mark className={cn("rounded-[2px] px-0.5 text-inherit", markClass(color))} data-testid="quote-term">
        {text.slice(start, end)}
      </mark>
      {text.slice(end)}
    </>
  );
}

/**
 * A JD quote of a pay signal. A long one is shown as a window of about two lines around its term (the amount, the
 * keyword), which is highlighted; "expand" shows it whole. Short quotes are shown whole and have no button.
 */
export function ClampedQuote({ text, term, color, lang, className, expandLabel, collapseLabel, label, testId = "signal-quote" }: ClampedQuoteProps) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = !fitsWhole(text, QUOTE_CLAMP_CHARS);
  const view = open || !long ? { start: 0, end: text.length, cutStart: false, cutEnd: false } : quoteWindow(text, term, QUOTE_CLAMP_CHARS, QUOTE_CLAMP_LEAD_CHARS);
  const shown = text.slice(view.start, view.end);

  return (
    <blockquote lang={lang} className={cn("text-muted-foreground border-l-2 pl-3 [overflow-wrap:anywhere]", className)} data-testid={testId} data-expanded={long ? open : undefined}>
      <span id={id} className={cn(!open && long && "line-clamp-2")} data-testid="signal-quote-text">
        {label ? <span className="text-xs">{label}: </span> : null}“{view.cutStart ? "… " : ""}
        <Marked text={shown} term={term} color={color} from={view.start} />
        {view.cutEnd ? " …" : ""}”
      </span>
      {long ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => setOpen((value) => !value)}
          className={cn(INK_LINK, "ml-1.5 text-xs")}
          data-testid="signal-quote-toggle"
        >
          {open ? collapseLabel : expandLabel}
        </button>
      ) : null}
    </blockquote>
  );
}
