import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";

export default async function JobNotFound() {
  const t = await getTranslations("dashboard.detail");
  return (
    <div className="flex flex-col items-start gap-3" data-testid="job-not-found">
      <h1 className="text-2xl font-semibold tracking-tight">{t("notFound.title")}</h1>
      <p className="text-muted-foreground">{t("notFound.description")}</p>
      <Link href="/jobs" className={buttonVariants({ variant: "outline" })}>
        {t("back")}
      </Link>
    </div>
  );
}
