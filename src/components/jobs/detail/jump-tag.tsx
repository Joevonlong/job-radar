"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

import { requestJdJump } from "./marks";

/**
 * A signal tag that jumps to its sentence in the JD: shows the original text, scrolls the highlighted quote to the
 * middle and flashes it. Only used for a quote the JD really contains (the caller checks); without one the tag is plain.
 */
export function JumpTag({ index, label, className, children }: { index: number; label: string; className?: string; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={() => requestJdJump(index)}
      aria-label={label}
      title={label}
      className={cn("press inline-flex max-w-full cursor-pointer items-center rounded-tag text-left", className)}
      data-testid="jump-tag"
      data-quote-index={index}
    >
      {children}
    </button>
  );
}
