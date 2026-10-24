"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { addWatchedCompanyAction, removeWatchedCompanyAction } from "@/app/interests/actions";
import { Button } from "@/components/ui/button";
import type { CompanyOverviewItem } from "@/lib/companies/overview";
import { toastTone } from "@/lib/toast";

export function WatchToggle({ row }: { row: Pick<CompanyOverviewItem, "name" | "watched" | "watchedEntry" | "watchedByFlagOnly"> }) {
  const t = useTranslations("companies");
  const tErrors = useTranslations("interests.formErrors");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  if (row.watchedByFlagOnly) return <span className="text-body-sm text-ink-2">{t("watchedByFlag")}</span>;
  const entry = row.watchedEntry;
  if (row.watched && entry === null) return null;

  function toggle() {
    startTransition(async () => {
      try {
        const result = row.watched && entry !== null
          ? await removeWatchedCompanyAction({ name: entry })
          : await addWatchedCompanyAction({ name: row.name });
        if (result.status === "saved") {
          toastTone("success", t(row.watched ? "unwatchedToast" : "watchedToast", { name: row.name }));
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
