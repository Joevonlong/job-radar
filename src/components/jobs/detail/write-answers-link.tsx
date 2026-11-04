import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * The application writer entry on the job page's action row: the workbench, or (writer off and nothing written yet) the setting that turns
 * it on, with how many of the job's answers are final once there are any. Labels come in resolved, so the page's server translator and a test can both fill it.
 */
export function WriteAnswersLink({ href, enabled, label, countLabel, className }: { href: string; enabled: boolean; label: string; countLabel: string | null; className?: string }) {
  return (
    <Link href={href} className={cn(buttonVariants({ variant: "outline" }), className)} data-testid="action-write" data-enabled={enabled}>
      {label}
      {countLabel !== null ? (
        <span className="text-ink-3 font-mono text-data" data-testid="action-write-count">
          {countLabel}
        </span>
      ) : null}
    </Link>
  );
}
