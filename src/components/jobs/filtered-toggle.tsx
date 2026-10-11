import { useTranslations } from "next-intl";

import { QuickFilter } from "./quick-filter";

/**
 * "Show filtered" chip: a link, so the state is in the URL and survives a reload. `href` is the URL with the flag flipped.
 * With `only` (the "filtered out" numbers of /insights open the list so) the chip says that only the filtered jobs are
 * listed, and removing it goes back to the normal list (`href`).
 */
export function FilteredToggle({ active, href, only = false }: { active: boolean; href: string; only?: boolean }) {
  const t = useTranslations("filter.toggle");
  if (only) return <QuickFilter active href={href} offLabel={t("only")} onLabel={t("only")} removeLabel={t("onlyRemove")} testId="toggle-filtered-only" />;
  return <QuickFilter active={active} href={href} offLabel={t("show")} onLabel={t("showing")} removeLabel={t("hide")} testId="toggle-filtered" />;
}
