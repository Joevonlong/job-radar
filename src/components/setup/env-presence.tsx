"use client";

import { CheckCircle2, CircleDashed } from "lucide-react";
import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";
import type { EnvPresence } from "@/lib/setup/types";

/** Environment variables by name with "set" / "not set". Values are never part of this (the server only sends names and booleans). */
export function EnvPresenceList({ env, className }: { env: readonly EnvPresence[]; className?: string }) {
  const t = useTranslations("setup.env");
  if (env.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-x-sp-3 gap-y-sp-1", className)} data-testid="env-presence">
      {env.map((entry) => (
        <li key={entry.name} className="flex items-center gap-1.5 font-mono text-data" data-env={entry.name} data-present={entry.present}>
          {entry.present ? <CheckCircle2 aria-hidden className="size-3.5 text-good" /> : <CircleDashed aria-hidden className="size-3.5 text-ink-3" />}
          <span className="font-semibold text-ink">{entry.name}</span>
          <span className={entry.present ? "text-ink-2" : "text-ink-3"}>{entry.present ? t("set") : t("missing")}</span>
        </li>
      ))}
    </ul>
  );
}
