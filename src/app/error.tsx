"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { unstable_isUnrecognizedActionError } from "next/navigation";

import { Button } from "@/components/ui/button";
import { CONFIG_ERROR_DIGEST_PREFIX, configFileFromDigest } from "@/lib/config/error-digest";

/** Last-resort boundary: production errors expose only the safe digest, never their server message. */
export default function ErrorPage({ error, retry }: { error: unknown; retry: () => void }) {
  const t = useTranslations("dashboard.error");
  const digest = typeof error === "object" && error !== null && "digest" in error && typeof error.digest === "string" ? error.digest : "";
  const config = digest.startsWith(CONFIG_ERROR_DIGEST_PREFIX);
  const updated = unstable_isUnrecognizedActionError(error);
  return (
    <div className="flex flex-col items-start gap-3" role="alert" data-testid="page-error">
      <h1 className="text-2xl font-semibold tracking-tight">{t(updated ? "updatedTitle" : config ? "configTitle" : "title")}</h1>
      <p className="text-muted-foreground max-w-prose">{updated ? t("updatedDescription") : config ? t("configDescription", { file: configFileFromDigest(digest) ?? t("configFile") }) : t("description")}</p>
      {config ? <Link href="/settings?tab=advanced" className="font-bold underline underline-offset-4">{t("repair")}</Link> : null}
      <Button variant="outline" onClick={() => updated ? window.location.reload() : retry()}>
        {t(updated ? "reload" : "retry")}
      </Button>
    </div>
  );
}
