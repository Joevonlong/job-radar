"use client";

import type { ReactNode } from "react";

import { OPEN_BACKFILL_EVENT } from "./backfill-action";

/** Jumps to a card's Backfill control and opens its panel (without JavaScript the link still jumps to the button). */
export function BackfillGapLink({ targetId, children }: { targetId: string; children: ReactNode }) {
  return (
    <a
      href={`#${targetId}`}
      className="underline underline-offset-4 focus-visible:outline-bw"
      data-testid="backfill-gap-link"
      onClick={() => window.dispatchEvent(new CustomEvent<string>(OPEN_BACKFILL_EVENT, { detail: targetId }))}
    >
      {children}
    </a>
  );
}
