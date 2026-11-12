import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import type { Permission } from "@/lib/agent-access/permissions";

/** One granted permission. One the global matrix does not allow is kept but gives nothing: dashed and struck through, with the reason on hover and for screen readers. */
export function PermissionPill({ permission, effective }: { permission: Permission; effective: boolean }) {
  const t = useTranslations("agents.connections");
  if (effective) {
    return (
      <Badge variant="skill" data-testid="permission-pill" data-effective="true">
        {permission}
      </Badge>
    );
  }
  return (
    <Badge variant="skill-miss" className="line-through" title={t("ineffective")} data-testid="permission-pill" data-effective="false">
      {permission}
      <span className="sr-only"> ({t("ineffective")})</span>
    </Badge>
  );
}
