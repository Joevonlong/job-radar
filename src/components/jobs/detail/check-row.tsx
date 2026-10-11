"use client";

import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { requestJdJump } from "./marks";

export type CheckRowTone = "good" | "bad" | "warn" | "dim";

export interface CheckRowQuote {
  /** Verbatim JD text (C7). */
  text: string;
  /** A short label before the quote ("refusal", "support"). */
  label?: string;
}

export interface CheckRowProps {
  title: string;
  /** The conclusion line. */
  text: ReactNode;
  tone: CheckRowTone;
  /** `data-testid` of the row and `data-state` of its conclusion. */
  testId: string;
  state: string;
  quotes?: readonly CheckRowQuote[];
  /** Index of the JD panel mark to jump to ("View in the original"); absent = no button (the JD does not show the quote). */
  jump?: { index: number; label: string };
  /** Extra data attributes of the conclusion. */
  kind?: string | null;
}

const TONE_CLASS: Record<CheckRowTone, string> = { good: "text-good", bad: "text-bad", warn: "text-warning-text", dim: "text-ink-2" };

/**
 * One row of the detail page's checks card for a stored job check (visa sponsorship, …): the title, a coloured conclusion,
 * the quotes it rests on and "View in the original", which jumps to the JD panel's mark.
 */
export function CheckRow({ title, text, tone, testId, state, quotes = [], jump, kind }: CheckRowProps) {
  return (
    <div className="mt-2.5 flex min-w-0 flex-col gap-1.5" data-testid={testId}>
      <span className="text-cap text-ink-3 text-cap-style">{title}</span>
      <span className={cn("text-data font-mono", TONE_CLASS[tone])} data-testid={`${testId}-state`} data-state={state} data-kind={kind ?? undefined} data-tone={tone}>
        {text}
      </span>
      {quotes.length > 0 ? (
        <ul className="flex min-w-0 flex-col gap-1">
          {quotes.map((quote, index) => (
            <li key={index} className="min-w-0">
              <blockquote className="border-border text-ink-2 border-l-bw pl-3 font-mono text-data break-words" data-testid={`${testId}-quote`}>
                {quote.label ? <span className="text-ink-3">[{quote.label}] </span> : null}
                {quote.text}
              </blockquote>
            </li>
          ))}
        </ul>
      ) : null}
      {jump ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => requestJdJump(jump.index)} data-testid={`${testId}-jump`}>
            {jump.label}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
