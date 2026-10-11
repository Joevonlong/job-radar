"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";

/** Last-resort boundary of every page: most often the database is not reachable. */
export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const t = useTranslations("dashboard.error");
  return (
    <div className="flex flex-col items-start gap-3" role="alert" data-testid="page-error">
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-muted-foreground max-w-prose">{t("description")}</p>
      <Button variant="outline" onClick={() => reset()}>
        {t("retry")}
      </Button>
    </div>
  );
}
