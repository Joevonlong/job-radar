"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { diffYaml } from "@/lib/config/diff";
import type { AdvancedLayer } from "@/lib/settings/advanced/types";

import { DiffView } from "./diff-view";

interface ConflictBannerProps {
  /** The text the editor was opened on, and the one on disk now (both masked). */
  opened: string;
  current: { text: string; layer: AdvancedLayer };
  onLoadLatest: () => void;
  onCopyMine: () => void;
}

/** Shown when a save was refused because the file changed after the editor opened it: "opened → now", and the two ways out. No auto-merge. */
export function ConflictBanner({ opened, current, onLoadLatest, onCopyMine }: ConflictBannerProps) {
  const t = useTranslations("settings.advanced.conflict");
  const lines = diffYaml(opened, current.text, 3);
  return (
    <div role="alert" data-testid="conflict-banner" className="border-bad bg-card flex flex-col gap-3 rounded-card border-bw px-4 py-3">
      <p className="text-bad flex items-center gap-2 font-bold">
        <AlertTriangle aria-hidden className="size-4 shrink-0" />
        {t("title")}
      </p>
      <p className="text-ink-2 text-body-sm">{t("hint")}</p>
      <div className="flex flex-col gap-1">
        <p className="text-label font-bold">{t("openedToNow")}</p>
        {lines.length === 0 ? <p className="text-ink-2 text-body-sm">{t("sameText")}</p> : <DiffView lines={lines} />}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="primary" size="sm" onClick={onLoadLatest} data-testid="conflict-load-latest">
          {t("loadLatest")}
        </Button>
        <Button type="button" variant="default" size="sm" onClick={onCopyMine} data-testid="conflict-copy-mine">
          {t("copyMine")}
        </Button>
      </div>
    </div>
  );
}
