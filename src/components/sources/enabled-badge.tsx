import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The "enabled / disabled" pill of a channel, the one look everywhere (/sources cards, the fallback chain, the settings page):
 * the green status pill when it is on, a dashed grey one when it is off. A channel that is on but cannot work (missing key) says
 * so in its own warning badge next to this one. The words come from the caller.
 */
export function EnabledBadge({ enabled, children, className, ...data }: { enabled: boolean; children: ReactNode; className?: string } & Record<`data-${string}`, string | undefined>) {
  return (
    <Badge variant={enabled ? "status-good" : "status"} className={cn("font-semibold", !enabled && "text-ink-3 border-dashed", className)} {...data}>
      {children}
    </Badge>
  );
}
