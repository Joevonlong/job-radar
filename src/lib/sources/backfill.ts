import type { SourcesView } from "@/lib/sources/view";

export interface BackfillCost {
  paidChannels: string[];
  jsearch: boolean;
}

export interface BackfillOptions {
  maxHours: number;
  channelIds: string[];
  cascade: boolean;
  local: BackfillCost;
  all: BackfillCost;
}

/** Enabled, implemented sources that can participate; credentials and budgets still gate execution. */
export function backfillCost(view: { cards: readonly Pick<SourcesView["cards"][number], "id" | "kind" | "enabled" | "registered">[] }, channelIds?: readonly string[]): BackfillCost {
  const cards = view.cards.filter((card) => card.enabled && card.registered && (!channelIds || channelIds.includes(card.id)));
  return { paidChannels: cards.filter((card) => card.kind === "paid").map((card) => card.id), jsearch: cards.some((card) => card.id === "jsearch") };
}

export function backfillPresets(maxHours: number): number[] {
  const presets = [12, 24, 48, 72, 168].filter((hours) => hours <= maxHours);
  return presets.length > 0 ? presets : [maxHours];
}
