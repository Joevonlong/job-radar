"use client";

import { Plus } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";

import { SaveBar } from "@/components/settings/save-bar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MAX_SIGNAL_CATEGORIES } from "@/lib/config/schemas/interests";
import type { CategorySignalCount } from "@/lib/db/queries/signal-categories";
import { changedPaths } from "@/lib/draft-diff";
import { weightScale } from "@/lib/interests/cap-bar";
import type { CategoryPreview as PreviewResult } from "@/lib/interests/preview";
import type { PresetOption } from "@/lib/interests/presets";
import type { InterestsActionState } from "@/lib/interests/types";
import type { CategoryDraft, VocabularyDraft, VocabularyFieldError } from "@/lib/interests/vocabulary-draft";
import { SIGNAL_COLORS, type SignalColor } from "@/lib/signals/palette";

import { CategoryAddDialog } from "./category-add-dialog";
import { CategoryDeleteDialog } from "./category-delete-dialog";
import { CategoryRow } from "./category-row";
import { RetiredPanel } from "./retired-panel";
import { WeightsPanel } from "./weights-panel";

interface VocabularyFormProps {
  initial: VocabularyDraft;
  /** Stored signals and jobs per category id; null when the database could not be read. */
  signalCounts: Readonly<Record<string, CategorySignalCount>> | null;
  state: InterestsActionState;
  pending: boolean;
  onSave: (draft: VocabularyDraft) => void;
  /** Presets of the add dialog. */
  presets?: readonly PresetOption[];
  /** `limits.ai_review_without_candidates`. */
  aiReviewWithoutCandidates?: boolean;
  /** The hit preview of one category with the whole form as it is. */
  onPreview?: (draft: VocabularyDraft, categoryId: string) => Promise<PreviewResult>;
}

/** Field errors of the last vocabulary save by draft path; the form is re-created after every successful save, so they never go stale. */
function errorMap(state: InterestsActionState): Map<string, VocabularyFieldError> {
  const map = new Map<string, VocabularyFieldError>();
  if (state.status === "error" && state.section === "vocabulary") for (const error of state.fieldErrors) if (!map.has(error.path)) map.set(error.path, error);
  return map;
}

/** Name of a category draft in `locale`: that language, then English, then Chinese, then the id (like `categoryLabel`). */
export function draftName(draft: Pick<CategoryDraft, "id" | "labelZh" | "labelEn">, locale: string): string {
  const zh = draft.labelZh.trim();
  const en = draft.labelEn.trim();
  const own = locale === "zh" ? zh : locale === "en" ? en : "";
  return own || en || zh || draft.id;
}

/** The fields that changed, counted per category (by id), plus the order, the deleted ones and the cap. */
function dirtyCount(draft: VocabularyDraft, initial: VocabularyDraft): number {
  const byId = (list: readonly CategoryDraft[]) => Object.fromEntries(list.map((category) => [category.id, category]));
  const order = (list: readonly CategoryDraft[]) => list.map((category) => category.id).join("\u0000");
  return (
    changedPaths(byId(draft.categories), byId(initial.categories)).length +
    (order(draft.categories) === order(initial.categories) ? 0 : 1) +
    (order(draft.retired) === order(initial.retired) ? 0 : 1) +
    (draft.bonusCap === initial.bonusCap ? 0 : 1)
  );
}

/**
 * The signal category editor of /interests: the cap bar over every category's weight, then the
 * categories as a list (add, move up / down, expand to edit, delete = move to the deleted ones), then the deleted
 * categories, which can be restored. One Save writes the whole vocabulary; the server checks it again (zod).
 */
export function VocabularyForm({ initial, signalCounts, state, pending, onSave, presets = [], aiReviewWithoutCandidates = true, onPreview }: VocabularyFormProps) {
  const t = useTranslations("interests");
  const tc = useTranslations("interests.categories");
  const locale = useLocale();
  const base = useId();
  const [draft, setDraft] = useState<VocabularyDraft>(initial);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const errors = errorMap(state);
  const savedIds = new Set([...initial.categories, ...initial.retired].map((category) => category.id));
  const formError = state.status === "error" && state.section === "vocabulary" ? state.formError : null;
  const capError = errors.get("bonusCap");
  const scale = weightScale(draft.categories.map((category) => ({ id: category.id, weight: category.weight })));
  const hasAmount = draft.categories.some((category) => category.kind === "amount");
  const full = draft.categories.length >= MAX_SIGNAL_CATEGORIES;
  const usedColors = new Set(draft.categories.map((category) => category.color));
  const freeColor: SignalColor = SIGNAL_COLORS.find((color) => color !== "neutral" && !usedColors.has(color)) ?? "slate";
  // a category with an error of the last save is open, so the message is seen
  const withErrors = new Set(draft.categories.flatMap((category, index) => ([...errors.keys()].some((path) => path.startsWith(`categories.${index}.`) || path === `categories.${index}`) ? [category.id] : [])));

  function patchCategory(index: number, patch: Partial<CategoryDraft>) {
    setDraft((current) => ({ ...current, categories: current.categories.map((category, i) => (i === index ? { ...category, ...patch } : category)) }));
  }
  function move(index: number, by: -1 | 1) {
    setDraft((current) => {
      const next = [...current.categories];
      const target = index + by;
      const moving = next[index];
      const other = next[target];
      if (moving === undefined || other === undefined) return current;
      next[index] = other;
      next[target] = moving;
      return { ...current, categories: next };
    });
  }
  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function add(category: CategoryDraft) {
    setDraft((current) => ({ ...current, categories: [...current.categories, category] }));
    setExpanded((current) => new Set([...current, category.id]));
  }
  function confirmDelete() {
    const id = deleting;
    setDeleting(null);
    if (id === null) return;
    setDraft((current) => {
      const category = current.categories.find((c) => c.id === id);
      if (!category) return current;
      const categories = current.categories.filter((c) => c.id !== id);
      // a saved category is kept, hidden, with its saved definition; an unsaved one just goes
      if (!savedIds.has(id)) return { ...current, categories };
      const savedVersion = [...initial.categories, ...initial.retired].find((c) => c.id === id) ?? category;
      return { ...current, categories, retired: [...current.retired, savedVersion] };
    });
  }
  function restore(id: string) {
    setDraft((current) => {
      const category = current.retired.find((c) => c.id === id);
      if (!category) return current;
      return { ...current, retired: current.retired.filter((c) => c.id !== id), categories: [...current.categories, category] };
    });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    onSave(draft);
  }

  const deletingDraft = deleting === null ? null : (draft.categories.find((category) => category.id === deleting) ?? null);

  return (
    <Card className="gap-4 py-4" data-testid="vocabulary-card">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 id={`${base}-heading`}>{t("vocabulary.title")}</h2>
        </CardTitle>
        <CardDescription>{t("vocabulary.description")}</CardDescription>
      </CardHeader>
      <form noValidate aria-labelledby={`${base}-heading`} onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-4 px-4 md:px-5">
          <WeightsPanel
            base={base}
            entries={draft.categories.map((category) => ({ id: category.id, name: draftName(category, locale), weight: category.weight, color: category.color }))}
            bonusCap={draft.bonusCap}
            capError={capError ? t(`errors.${capError.key}`, capError.params) : undefined}
            onCap={(text) => setDraft((current) => ({ ...current, bonusCap: text }))}
          />

          <section className="flex flex-col gap-2" aria-labelledby={`${base}-categories`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 id={`${base}-categories`} className="text-label font-bold">
                {tc("title", { count: draft.categories.length, max: MAX_SIGNAL_CATEGORIES })}
              </h3>
              <Button type="button" variant="outline" size="sm" disabled={full} onClick={() => setAdding(true)} data-testid="category-add">
                <Plus aria-hidden /> {tc("add")}
              </Button>
            </div>
            {full ? <p className="text-ink-2 text-body-sm">{tc("full", { max: MAX_SIGNAL_CATEGORIES })}</p> : null}
            {errors.get("categories") ? (
              <p role="alert" className="text-bad text-body-sm font-bold">
                {t(`errors.${errors.get("categories")?.key ?? "invalid"}`, errors.get("categories")?.params)}
              </p>
            ) : null}
            <ul className="flex flex-col gap-2" data-testid="category-list">
              {draft.categories.map((category, index) => (
                <CategoryRow
                  key={category.id}
                  base={base}
                  draft={category}
                  index={index}
                  total={draft.categories.length}
                  name={draftName(category, locale)}
                  isNew={!savedIds.has(category.id)}
                  expanded={expanded.has(category.id) || withErrors.has(category.id)}
                  onToggle={() => toggle(category.id)}
                  scale={scale}
                  errors={errors}
                  onChange={(patch) => patchCategory(index, patch)}
                  onMove={(by) => move(index, by)}
                  onDelete={() => setDeleting(category.id)}
                  aiReviewWithoutCandidates={aiReviewWithoutCandidates}
                  {...(onPreview ? { onPreview: () => onPreview(draft, category.id) } : {})}
                />
              ))}
            </ul>
          </section>

          <RetiredPanel
            retired={draft.retired}
            nameOf={(category) => draftName(category, locale)}
            blockedReason={(category) => (full ? tc("retired.blockedFull", { max: MAX_SIGNAL_CATEGORIES }) : category.kind === "amount" && hasAmount ? tc("retired.blockedAmount") : null)}
            onRestore={restore}
          />

          {formError ? (
            <p role="alert" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
              {t(`formErrors.${formError}`)}
            </p>
          ) : null}
          {state.status === "error" && state.section === "vocabulary" && formError === null && state.fieldErrors.length > 0 ? (
            <p role="alert" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
              {t("vocabulary.fieldErrors", { count: state.fieldErrors.length })}
            </p>
          ) : null}
        </CardContent>
        <SaveBar
          floating
          dirtyCount={dirtyCount(draft, initial)}
          pending={pending}
          onRevert={() => setDraft(initial)}
          saveTestId="vocabulary-save"
          labels={{ dirty: (count) => t("actions.dirtyCount", { count }), clean: t("actions.clean"), save: t("actions.save"), saving: t("actions.saving"), revert: t("actions.reset") }}
        />
      </form>

      <CategoryAddDialog
        open={adding}
        onOpenChange={setAdding}
        takenIds={[...draft.categories, ...draft.retired].map((category) => category.id)}
        hasAmount={hasAmount}
        initialColor={freeColor}
        onAdd={add}
        presets={presets}
      />
      <CategoryDeleteDialog
        target={deletingDraft ? { id: deletingDraft.id, name: draftName(deletingDraft, locale), isNew: !savedIds.has(deletingDraft.id) } : null}
        counts={signalCounts}
        onCancel={() => setDeleting(null)}
        onConfirm={confirmDelete}
      />
    </Card>
  );
}
