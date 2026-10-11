import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface InsightCardProps {
  title: string;
  description?: string | undefined;
  /** Short note at the right of the title (a unit, what solid means). */
  aux?: ReactNode;
  testId: string;
  children: ReactNode;
  className?: string;
}

/** The frame of every /insights card: a titled section (header strip, then body) with a one-line explanation of what is counted. */
export function InsightCard({ title, description, aux, testId, children, className }: InsightCardProps) {
  const headingId = `${testId}-heading`;
  return (
    <section aria-labelledby={headingId} data-testid={testId} className={cn("min-w-0", className)}>
      <Card className="h-full gap-0">
        <header className="border-b-bw border-border flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
          <h2 id={headingId} className="font-display text-h2">
            {title}
          </h2>
          {aux ? <span className="text-ink-3 text-data ml-auto font-mono">{aux}</span> : null}
        </header>
        <div className="flex min-w-0 flex-1 flex-col gap-3 px-4 py-3.5">
          {description ? <p className="text-ink-2 text-data leading-relaxed">{description}</p> : null}
          {children}
        </div>
      </Card>
    </section>
  );
}

/** A quiet line for a card that has nothing to count in the chosen range. */
export function CardEmpty({ children }: { children: ReactNode }) {
  return (
    <p className="text-ink-2 border-ink-3 text-data rounded-btn border-[1.5px] border-dashed px-3 py-6 text-center" data-testid="card-empty">
      {children}
    </p>
  );
}
