import type { ReactNode } from "react";

import { signalColorClasses, type SignalColor } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

interface SignalBadgeProps {
  /** Category id (`data-tier`, the hook tests and styles use). */
  tier: string;
  /** The category's palette colour: a 15% tint behind the badge, the label in ink. */
  color: SignalColor;
  /** The category's icon, shown before the label. */
  icon?: string | null;
  children: ReactNode;
  /** Tooltip, e.g. the category name. */
  title?: string;
  className?: string;
  /** Neutral look, no icon: the signal is shown but is not a high-pay signal (a stated amount below the salary floor). */
  muted?: boolean;
}

/** Pay / benefit signal badge of a list row, coloured by its category. */
export function SignalBadge({ tier, color, icon, children, title, className, muted = false }: SignalBadgeProps) {
  return (
    <span
      data-slot="signal-badge"
      data-tier={tier}
      data-muted={muted ? "true" : undefined}
      title={title ?? tier}
      className={cn(
        "inline-flex min-h-[22px] max-w-full items-center gap-1 rounded-full border px-2 py-[3px] text-xs leading-tight font-medium tabular-nums",
        signalColorClasses(muted ? "neutral" : color).tint,
        className,
      )}
    >
      {icon && !muted ? <span aria-hidden>{icon}</span> : null}
      {children}
    </span>
  );
}

/** The dashed "unknown" look: a missing fact must not read as "none" (design rule for unknown values). */
export function UnknownBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      data-slot="unknown-badge"
      className={cn(
        "text-muted-foreground inline-flex h-[22px] items-center gap-1 rounded-full border border-dashed px-2 text-xs leading-none whitespace-nowrap",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A neutral fact badge (German level, contract kind, ...). `tone` picks the accent. */
export function FactBadge({ children, tone = "warning", title }: { children: ReactNode; tone?: "warning" | "accent"; title?: string }) {
  return (
    <span
      data-slot="fact-badge"
      title={title}
      className={cn(
        "inline-flex min-h-[22px] max-w-full items-center gap-1 rounded-full border px-2 py-[3px] text-xs leading-tight font-medium",
        tone === "warning" ? "border-warning/30 bg-warning/15 text-foreground" : "border-primary/30 bg-accent text-accent-foreground",
      )}
    >
      {children}
    </span>
  );
}
