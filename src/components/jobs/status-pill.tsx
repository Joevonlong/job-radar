import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { ApplicationStatus } from "@/lib/db/repos/applications";
import { cn } from "@/lib/utils";

type PillVariant = "status" | "status-on" | "status-good" | "status-warn";

/** Pill look per application status (tokens.md: the colours follow the board columns). */
const PILL_VARIANT: Record<ApplicationStatus, PillVariant> = {
  new: "status",
  interested: "status-on",
  preparing: "status-on",
  applied: "status-warn",
  interviewing: "status-good",
  offer: "status-good",
  rejected: "status",
  withdrawn: "status",
  archived: "status",
};

/** The application status of a row as a pill. `data-slot="status-chip"` is kept for the tests that look for it. */
export function StatusPill({ status, className }: { status: ApplicationStatus; className?: string }) {
  const t = useTranslations("dashboard.status");
  return (
    <Badge
      variant={PILL_VARIANT[status]}
      data-slot="status-chip"
      data-status={status}
      className={cn(status === "archived" && "border-dashed text-ink-3 line-through", (status === "rejected" || status === "withdrawn") && "border-dashed text-ink-2", className)}
    >
      {t(status)}
    </Badge>
  );
}
