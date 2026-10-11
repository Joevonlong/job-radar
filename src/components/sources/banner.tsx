import { AlertTriangle, OctagonAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * v3 banner (tokens.md "反馈"): stays until the problem is solved. Yellow = warning (always with the hatch stripe, colour
 * is never the only cue), red = failure. The caller supplies the text; `role="alert"` makes it announce itself.
 */
export function Banner({ tone, testId, children, ...data }: { tone: "warn" | "bad"; testId?: string; children: ReactNode } & Record<`data-${string}`, string | undefined>) {
  const Icon = tone === "bad" ? OctagonAlert : AlertTriangle;
  return (
    <div
      role="alert"
      data-testid={testId}
      data-tone={tone}
      className={cn(
        "flex items-stretch overflow-hidden rounded-card border-bw border-border text-body-sm font-semibold shadow-e2",
        tone === "bad" ? "bg-bad text-on-bad" : "bg-warn text-on-signal",
      )}
      {...data}
    >
      <span aria-hidden className={cn("jr-hatch w-3 flex-none border-r-bw border-border", tone === "bad" ? "text-on-bad" : "text-ink")} />
      <div className="flex min-w-0 flex-1 items-start gap-2 px-4 py-3">
        <Icon aria-hidden className="mt-0.5 size-4 flex-none" />
        <div className="min-w-0 [overflow-wrap:anywhere]">{children}</div>
      </div>
    </div>
  );
}
