"use client";

import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { ACTION_FAILURE_EVENT, ACTION_UPDATED_MARKER } from "@/lib/actions/client";
import { toastTone } from "@/lib/toast";

/** A full reload obtains the current action IDs. Keep the explanation visible after that reload as well. */
export function ActionFeedback() {
  const t = useTranslations("dashboard.error");
  useEffect(() => {
    try {
      if (sessionStorage.getItem(ACTION_UPDATED_MARKER) === "1") {
        sessionStorage.removeItem(ACTION_UPDATED_MARKER);
        toastTone("info", t("updatedToast"), { id: "action-updated" });
      }
    } catch {
      // Storage can be disabled; recovery still reloads the app.
    }
    function failed(event: Event) {
      if (!(event instanceof CustomEvent)) return;
      if (event.detail === "updated") {
        toastTone("info", t("updatedDescription"), { id: "action-updated" });
        try {
          sessionStorage.setItem(ACTION_UPDATED_MARKER, "1");
        } catch {
          // The toast before the reload remains the explanation when storage is unavailable.
        }
        window.location.reload();
      } else if (event.detail === "failed") {
        toastTone("error", t("actionFailed"), { id: "action-failed" });
      }
    }
    window.addEventListener(ACTION_FAILURE_EVENT, failed);
    return () => window.removeEventListener(ACTION_FAILURE_EVENT, failed);
  }, [t]);
  return null;
}
