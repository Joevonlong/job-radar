"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { careerErrorMessageKey } from "./error-messages";

export function CareerStatus({ code }: { code: string }) {
  const t = useTranslations("career");
  return (
    <div
      role="status"
      aria-live="polite"
      className="text-body-sm"
      data-code={code && code !== "saved" ? code : undefined}
    >
      {code === "saved" && t("saved")}
      {code && code !== "saved" && t(careerErrorMessageKey(code))}
      {code === "stale" && (
        <Button type="button" variant="outline" onClick={() => window.location.reload()}>
          {t("reload")}
        </Button>
      )}
    </div>
  );
}
