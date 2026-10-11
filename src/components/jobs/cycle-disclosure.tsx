"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The cycle card of Today. On a desktop it is the whole card (`header` row, then `children`). On a phone (below `md`) it collapses to
 * one line (`line`) with a disclosure: the first job has to be on the first screen, the channel chips and notices open on tap.
 */
export function CycleDisclosure({ line, header, label, children, className }: { line: ReactNode; header: ReactNode; label: string; children: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        title={label}
        data-testid="cycle-toggle"
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full min-w-0 items-center gap-sp-2 px-sp-3 py-sp-2 text-left text-body-sm md:hidden"
      >
        <span className="min-w-0 flex-1 truncate">{line}</span>
        <ChevronDown aria-hidden className={cn("size-4 flex-none transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <div className="max-md:hidden">{header}</div>
      <div id={bodyId} className={cn(className, !open && "max-md:hidden")}>
        {children}
      </div>
    </>
  );
}
