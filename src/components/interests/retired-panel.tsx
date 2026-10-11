"use client";

import { RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";

import { SignalTag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { CategoryDraft } from "@/lib/interests/vocabulary-draft";
import { categoryCode } from "@/lib/signals/catalog";

interface RetiredPanelProps {
  retired: readonly CategoryDraft[];
  /** Name of a category in the page language. */
  nameOf: (draft: CategoryDraft) => string;
  /** Why a category cannot come back right now (another amount category, the list is full); null = it can. */
  blockedReason: (draft: CategoryDraft) => string | null;
  onRestore: (id: string) => void;
}

/**
 * "Deleted categories": each one with its stored definition, and a button that puts it back at the end of the list
 * (saved with the form; the next cycle extracts its signals again). Their ids stay taken.
 */
export function RetiredPanel({ retired, nameOf, blockedReason, onRestore }: RetiredPanelProps) {
  const t = useTranslations("interests.categories.retired");
  if (retired.length === 0) return null;
  return (
    <section className="border-grid flex flex-col gap-2 border-t-bw pt-3" aria-labelledby="retired-categories-title" data-testid="retired-panel">
      <h3 id="retired-categories-title" className="text-label font-bold">
        {t("title")}
      </h3>
      <p className="text-ink-2 text-body-sm">{t("hint")}</p>
      <ul className="flex flex-col gap-2">
        {retired.map((draft) => {
          const name = nameOf(draft);
          const blocked = blockedReason(draft);
          return (
            <li key={draft.id} className="flex flex-wrap items-center gap-x-3 gap-y-1" data-testid={`retired-${draft.id}`}>
              <SignalTag code={categoryCode(draft.id)} icon={draft.icon.trim() === "" ? null : draft.icon} color={draft.color} className="opacity-70">
                {name}
              </SignalTag>
              <span className="text-ink-3 font-mono text-data-sm">id: {draft.id}</span>
              <Button type="button" variant="outline" size="xs" disabled={blocked !== null} title={blocked ?? undefined} aria-label={t("restore", { name })} onClick={() => onRestore(draft.id)} data-testid={`retired-restore-${draft.id}`}>
                <RotateCcw aria-hidden /> {t("restoreShort")}
              </Button>
              {blocked ? <span className="text-ink-2 text-body-sm">{blocked}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
