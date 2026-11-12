"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";

/** The advanced editor's address for a config (`?tab=advanced&file=<file name without .yaml>`). */
export function repairHref(file: string): string {
  return `/settings?tab=advanced&file=${encodeURIComponent(file.replace(/\.yaml$/, ""))}`;
}

/** A config file a form needs cannot be read: what is wrong, and a link to repair it in the advanced editor. */
export function LoadError({ file, repair, message }: { file: string; repair: string; message: string }) {
  const t = useTranslations("settings.loadError");
  return (
    <div role="alert" className="border-bad bg-card flex flex-col gap-1 rounded-card border-bw px-4 py-3 text-body">
      <p className="text-bad flex items-center gap-2 font-bold [overflow-wrap:anywhere]">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />
        {t("title", { file })}
      </p>
      <p className="text-ink-2">{t("hint")}</p>
      <pre className="text-ink-2 mt-1 font-mono text-data break-words whitespace-pre-wrap">{message}</pre>
      <Link href={repairHref(repair)} className="font-bold underline underline-offset-4 hover:bg-hi hover:text-hi-ink" data-testid="repair-link">
        {t("repair")}
      </Link>
    </div>
  );
}
