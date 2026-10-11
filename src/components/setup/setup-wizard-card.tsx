import { Compass } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";

import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/** Settings → Manual actions: open the first-run setup again (review mode once it is complete: no redirect, changes apply at once). */
export function SetupWizardCard() {
  const t = useTranslations("settings.control.setupWizard");
  return (
    <Card className="gap-0 py-0" data-testid="setup-wizard-card">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 className="text-base font-semibold">{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex px-4 py-4 md:px-5">
        <Link href="/setup" className={cn(buttonVariants({ variant: "default", size: "sm" }), "w-fit")} data-testid="setup-wizard-open">
          <Compass aria-hidden />
          {t("open")}
        </Link>
      </CardContent>
    </Card>
  );
}
