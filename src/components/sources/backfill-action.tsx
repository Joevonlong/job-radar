"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";

import { TriggerButton } from "@/components/control/trigger-button";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { resolveLocale } from "@/i18n/locale";
import { formatInteger } from "@/lib/format/numbers";
import { backfillPresets, type BackfillOptions } from "@/lib/sources/backfill";

/** An inline confirmation panel; keeping it mounted preserves request progress when collapsed. */
export function BackfillAction({ id, options }: { id: string; options: BackfillOptions }) {
  const t = useTranslations("sources.backfill");
  const locale = resolveLocale(useLocale());
  const panelId = useId();
  const presets = backfillPresets(options.maxHours);
  const [expanded, setExpanded] = useState(false);
  const [hours, setHours] = useState(presets[0]!);
  const [scope, setScope] = useState("local");
  const cost = scope === "all" ? options.all : options.local;
  const number = (value: number) => formatInteger(value, locale);
  return (
    <div className="min-w-0 text-body-sm" data-testid="backfill-action">
      <Button id={id} type="button" size="xs" variant="outline" aria-expanded={expanded} aria-controls={panelId} onClick={() => setExpanded(!expanded)}>
        {t("button")}
      </Button>
      <div id={panelId} hidden={!expanded} className="mt-sp-3 min-w-0 space-y-sp-3 rounded-cell border-bw border-grid bg-soft p-sp-3 [overflow-wrap:anywhere]">
        <label className="block space-y-sp-1">
          <span>{t("range")}</span>
          <NativeSelect value={hours} onChange={(event) => setHours(Number(event.target.value))}>
            {presets.map((value) => <option key={value} value={value}>{value % 24 === 0 ? t("days", { count: value / 24, number: number(value / 24) }) : t("hours", { number: number(value) })}</option>)}
          </NativeSelect>
        </label>
        <label className="block space-y-sp-1">
          <span>{t("scope")}</span>
          <NativeSelect value={scope} onChange={(event) => setScope(event.target.value)}>
            <option value="local">{t(options.cascade ? "thisCascade" : "thisChannel")}</option>
            <option value="all">{t("allChannels")}</option>
          </NativeSelect>
        </label>
        <p data-testid="backfill-cost">{cost.paidChannels.length > 0 ? t("paid", { channels: cost.paidChannels.join(", ") }) : t("noPaid")}</p>
        {cost.jsearch ? <p>{t("jsearch")}</p> : null}
        <p className="text-ink-2">{t("confirmation")}</p>
        <TriggerButton kind="backfill" backfillPayload={{ backfillHours: hours, ...(scope === "local" ? { channelIds: options.channelIds } : {}) }} />
      </div>
    </div>
  );
}
