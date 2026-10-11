import Link from "next/link";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

/** The terminal wordmark: amber mono caps with a blinking block cursor. `prefetch={false}` on the login page (no session yet). */
export function Brand({ className, prefetch }: { className?: string; prefetch?: false }) {
  const t = useTranslations("shell");
  return (
    <Link href="/" prefetch={prefetch} className={cn("term-cursor font-mono text-title font-bold tracking-wider text-term-amber", className)}>
      {t("brand")}
    </Link>
  );
}
