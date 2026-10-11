import type { ReactNode } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** A summary block of /sources (design `.kpi`): a mono label, then what it says, then the detail line. */
export function Block({ label, children, className, ...props }: { label: ReactNode; children: ReactNode; className?: string } & React.ComponentProps<"div">) {
  return (
    <Card className={cn("min-w-0 gap-1.5 px-4 py-3", className)} {...props}>
      <h2 className="text-ink-2 flex items-center gap-1.5 font-mono text-data font-semibold tracking-[0.04em] uppercase">{label}</h2>
      {children}
    </Card>
  );
}

/** The state word of a block. */
export function BlockState({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cn("font-sans text-title font-extrabold", className)}>{children}</p>;
}

/** The mono detail line of a block. */
export function BlockNote({ children, className, ...props }: { children: ReactNode; className?: string } & React.ComponentProps<"p">) {
  return (
    <p className={cn("text-ink-2 font-mono text-data break-words", className)} {...props}>
      {children}
    </p>
  );
}
