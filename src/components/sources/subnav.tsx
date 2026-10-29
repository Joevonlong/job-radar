import Link from "next/link";
import { useTranslations } from "next-intl";

import "../ai-usage/ai-usage.css";

export type SourcesSubpage = "overview" | "registry" | "aiUsage" | "logs";

/**
 * The sub-pages of /sources. Additive: a new sub-page is one more entry here (the source registry, the
 * AI usage statistics). The current one is a plain link with `aria-current="location"` ("page" is what the shell test counts for the sidebar).
 */
const ITEMS: readonly { id: SourcesSubpage; href: string }[] = [
  { id: "overview", href: "/sources" },
  { id: "registry", href: "/sources/registry" },
  { id: "aiUsage", href: "/sources/ai-usage" },
  { id: "logs", href: "/sources/logs" },
];

export function SourcesSubnav({ current }: { current: SourcesSubpage }) {
  const t = useTranslations("sources.subnav");
  return (
    <nav aria-label={t("label")} className="ai-subnav" data-testid="sources-subnav">
      {ITEMS.map((item) => (
        <Link key={item.id} href={item.href} aria-current={item.id === current ? "location" : undefined} data-subnav={item.id} data-testid={item.id === "logs" ? "activity-log-subnav" : `subnav-${item.id}`}>
          {t(item.id)}
        </Link>
      ))}
    </nav>
  );
}
