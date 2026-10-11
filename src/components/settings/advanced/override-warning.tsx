"use client";

import { TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";

import { Checkbox } from "@/components/ui/checkbox";

/**
 * The yellow note on the editor of a product default file (pipeline.yaml, models.yaml): a save writes the whole file into the user
 * directory, and later product updates of this file no longer apply. With `confirm` it also carries the "I understand" checkbox
 * the first save needs.
 */
export function OverrideWarning({ confirm }: { confirm?: { checked: boolean; onChange: (checked: boolean) => void } }) {
  const t = useTranslations("settings.advanced.override");
  return (
    <div role="note" data-testid="override-warning" className="bg-warn text-on-signal border-border flex flex-col gap-2 rounded-card border-bw px-3 py-2 text-body-sm">
      <p className="flex items-start gap-2 font-bold">
        <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{t("text")}</span>
      </p>
      {confirm ? (
        <label className="flex cursor-pointer items-center gap-2 font-bold">
          <Checkbox checked={confirm.checked} onCheckedChange={(next) => confirm.onChange(next === true)} data-testid="override-confirm" />
          {t("confirm")}
        </label>
      ) : null}
    </div>
  );
}
