"use client";

import { useTranslations } from "next-intl";

import { Led } from "@/components/viz";
import { registryTone, type RegistryStatus } from "@/lib/sources/registry/status";
import { TONE_TEXT } from "@/lib/sources/channel-tone";
import { cn } from "@/lib/utils";

/** Status light plus the state word; the colour is never the only cue. */
export function StatusCell({ status }: { status: RegistryStatus }) {
  const t = useTranslations("sourcesRegistry.status");
  const tone = registryTone(status);
  return (
    <span className={cn("inline-flex items-center gap-1.5 font-mono text-data font-bold", TONE_TEXT[tone])} data-testid="status-cell" data-status={status}>
      <Led tone={tone} label={false} />
      {t(status)}
    </span>
  );
}
