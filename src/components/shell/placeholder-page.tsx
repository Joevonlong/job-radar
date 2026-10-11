import { Hourglass } from "lucide-react";
import { getTranslations } from "next-intl/server";

import type { NavKey } from "./nav";
import { PageHeader } from "./page-header";

/**
 * A nav page that is not built yet: its title and what it will show, and an explicit "coming soon" state, so an
 * empty page never looks like a broken one.
 */
export async function PlaceholderPage({ pageKey }: { pageKey: NavKey }) {
  const [t, tSoon] = await Promise.all([getTranslations(`pages.${pageKey}`), getTranslations("pages.comingSoon")]);
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title={t("title")} description={t("description")} />
      <section
        className="border-border text-muted-foreground flex flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-16 text-center"
        aria-labelledby="coming-soon-title"
        data-testid="coming-soon"
        data-page={pageKey}
      >
        <Hourglass aria-hidden className="size-6" />
        <h2 id="coming-soon-title" className="text-foreground text-base font-semibold">
          {tSoon("title")}
        </h2>
        <p className="max-w-[48ch] text-sm">{tSoon("hint")}</p>
      </section>
    </div>
  );
}
