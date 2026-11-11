import Link from "next/link";
import { useTranslations } from "next-intl";

import { AGENTS_PAGE } from "@/lib/settings/tabs";

import "../ai-usage/ai-usage.css";

export type AgentsSubpage = "access";

/**
 * The sub-pages of the agent settings, styled like the /sources sub-nav. Additive: the activity log and the approvals each add one
 * entry here. The current one carries `aria-current="location"`.
 */
const ITEMS: readonly { id: AgentsSubpage; href: string }[] = [{ id: "access", href: AGENTS_PAGE }];

export function AgentsSubnav({ current }: { current: AgentsSubpage }) {
  const t = useTranslations("agents.subnav");
  return (
    <nav aria-label={t("label")} className="ai-subnav" data-testid="agents-subnav">
      {ITEMS.map((item) => (
        <Link key={item.id} href={item.href} aria-current={item.id === current ? "location" : undefined} data-subnav={item.id}>
          {t(item.id)}
        </Link>
      ))}
    </nav>
  );
}
