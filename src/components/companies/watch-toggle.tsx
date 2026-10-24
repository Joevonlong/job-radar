"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { addWatchedCompanyAction, removeWatchedCompaniesAction } from "@/app/interests/actions";
import { Button } from "@/components/ui/button";
import type { CompanyOverviewItem } from "@/lib/companies/overview";
import { toastTone } from "@/lib/toast";

export function WatchToggle({ row }: { row: Pick<CompanyOverviewItem, "name" | "watched" | "watchedEntries" | "watchedByFlagOnly" | "companyFlagWatched" | "watchable"> }) {
  const t = useTranslations("companies");
  const tErrors = useTranslations("interests.formErrors");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (row.watchedByFlagOnly) return <span className="text-body-sm text-ink-2">{t("watchedByFlag")}</span>;
  if (!row.watched && !row.watchable) {
    return <span className="text-body-sm text-ink-2">{t.rich("notWatchable", { interests: (chunks) => <Link href="/interests" className="underline underline-offset-4">{chunks}</Link> })}</span>;
  }
  if (row.watched && row.watchedEntries.length === 0) return null;

  function toggle() {
    startTransition(async () => {
      try {
        const result = row.watched
          ? await removeWatchedCompaniesAction({ names: row.watchedEntries })
          : await addWatchedCompanyAction({ name: row.name });
        if (result.status === "saved") {
          const message = row.watched ? (row.companyFlagWatched ? "stillWatchedToast" : "unwatchedToast") : "watchedToast";
          toastTone("success", t(message, { name: row.name }));
          router.refresh();
        } else if (result.status === "error") {
          toastTone("error", tErrors(result.formError ?? "invalidPayload"));
        }
      } catch {
        toastTone("error", t("watchFailed"));
      }
    });
  }

  return <Button type="button" variant="outline" size="sm" disabled={pending} onClick={toggle}>{t(row.watched ? "unwatch" : "watch")}</Button>;
}
