"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback } from "react";

import type { AgentSettingsResult } from "@/lib/agent-access/settings-service";
import { toastTone } from "@/lib/toast";

/**
 * Tells the owner how a save on the agent access page went, and returns whether it was saved. A stale save reloads the page's data:
 * the file changed elsewhere, so the form starts again from what is on disk now.
 */
export function useReportResult(): (result: AgentSettingsResult) => boolean {
  const t = useTranslations("agents.results");
  const router = useRouter();
  return useCallback(
    (result: AgentSettingsResult) => {
      if (result.status === "saved") {
        toastTone("success", t("saved"));
        return true;
      }
      toastTone(result.status === "stale" ? "warn" : "error", t(result.status));
      if (result.status === "stale") router.refresh();
      return false;
    },
    [t, router],
  );
}
