import type { ReactNode } from "react";

/**
 * One of the AI tab's numbered blocks: a number, a title and one sentence on top, then the block's own content, all inside its own
 * bordered frame so the four jobs (vendors, routing, limits, scoring) read as four separate places.
 */
export function AiBlock({ n, id, title, hint, children, className }: { n: number; id: string; title: string; hint: string; children: ReactNode; className?: string }) {
  const headingId = `ai-block-${id}-title`;
  return (
    <section aria-labelledby={headingId} data-testid={`ai-block-${id}`} className={`border-border bg-background flex min-w-0 flex-col rounded-card border-bw ${className ?? ""}`}>
      <header className="border-border bg-soft flex items-start gap-3 rounded-t-card border-b-bw px-4 py-3">
        <span aria-hidden className="bg-ink text-paper rounded-tag grid size-ctl-sm shrink-0 place-items-center font-mono text-label font-bold">
          {n}
        </span>
        <div className="flex min-w-0 flex-col">
          <h3 id={headingId} className="text-title">
            {title}
          </h3>
          <p className="text-ink-2 text-body-sm">{hint}</p>
        </div>
      </header>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

/** A small heading inside a block. */
export function SubHeading({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h4 className="text-label font-bold">{children}</h4>
      {hint ? <p className="text-ink-2 text-body-sm">{hint}</p> : null}
    </div>
  );
}
