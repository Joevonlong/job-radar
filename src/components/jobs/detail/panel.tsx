import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** A titled card (design `.card`): 2px border, hard shadow, header row with the heading and an optional aside, body below. */
export function Panel({ id, title, aside, children, className, bodyClassName }: { id: string; title: string; aside?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }) {
  return (
    <section aria-labelledby={id} className={cn("rounded-card border-bw border-border bg-card text-card-foreground shadow-e3 min-w-0 scroll-mt-20", className)}>
      <div className="border-b-bw border-border flex items-center justify-between gap-2.5 px-4 py-3">
        <h2 id={id} className="font-display text-h2">
          {title}
        </h2>
        {aside}
      </div>
      <div className={cn("min-w-0 px-4 py-3.5", bodyClassName)}>{children}</div>
    </section>
  );
}

/** The mono note at the right of a panel heading ("点标签跳到原文"). */
export function PanelAside({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-data text-ink-3 font-mono font-medium", className)}>{children}</span>;
}

/** The dashed box for "this fact is unknown / not there yet": a missing value must not look like "none". */
export function PlaceholderBox({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="border-border text-muted-foreground rounded-card border-dashed border-[1.5px] px-4 py-3" data-testid={testId}>
      {children}
    </div>
  );
}
