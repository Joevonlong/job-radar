"use client";

import { ArrowDown, ArrowUp, ChevronRight, Minus, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { Field, TagInput, describedBy } from "@/components/profile/fields";
import { SignalTag } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SegBlocks } from "@/components/viz";
import { MAX_CATEGORY_ICON_CHARS } from "@/lib/config/schemas/interests";
import { categoryCode, CATEGORY_CODE_MAX_CHARS } from "@/lib/signals/catalog";
import { parseWeight, WEIGHT_CELLS, type WeightScale } from "@/lib/interests/cap-bar";
import type { CategoryPreview as PreviewResult } from "@/lib/interests/preview";
import { isValidPattern, type CategoryDraft, type VocabularyFieldError } from "@/lib/interests/vocabulary-draft";
import { signalColorClasses } from "@/lib/signals/palette";
import { cn } from "@/lib/utils";

import { CategoryPreview } from "./category-preview";
import { ColorPicker } from "./color-picker";
import { PatternList } from "./pattern-list";

/** A weight stepped by one point; text that is not a number steps from 0. Never below 0. */
export function stepWeight(text: string, by: 1 | -1): string {
  const next = Math.max(0, Math.round(((parseWeight(text) ?? 0) + by) * 100) / 100);
  return String(next);
}

/** Keywords shown in the collapsed row before "+N". */
const KEYWORDS_SHOWN = 4;

interface CategoryRowProps {
  /** Id prefix of the row's controls. */
  base: string;
  draft: CategoryDraft;
  index: number;
  /** Rows in the list (for the move buttons). */
  total: number;
  /** Name in the page language (with the usual fallbacks). */
  name: string;
  /** Not saved yet: its id and kind can still change by deleting and adding it again. */
  isNew: boolean;
  expanded: boolean;
  onToggle: () => void;
  scale: WeightScale;
  /** Field errors of the last save by draft path (`categories.<index>.…`). */
  errors: Map<string, VocabularyFieldError>;
  onChange: (patch: Partial<CategoryDraft>) => void;
  onMove: (by: -1 | 1) => void;
  onDelete: () => void;
  /** `limits.ai_review_without_candidates` (a keyword category without words relies on it). */
  aiReviewWithoutCandidates?: boolean;
  /** Runs the hit preview of this category with the whole form; absent hides it. */
  onPreview?: () => Promise<PreviewResult>;
}

/**
 * One signal category of the editor: the collapsed head (its tag, words, weight cells, move up / down, delete) and,
 * expanded, every field: names, icon, colour, weight, high value, AI confirmation, AI definition and the vocabulary of its
 * kind. Everything follows the draft; the file only changes on Save.
 */
export function CategoryRow({ base, draft, index, total, name, isNew, expanded, onToggle, scale, errors, onChange, onMove, onDelete, aiReviewWithoutCandidates = true, onPreview }: CategoryRowProps) {
  const t = useTranslations("interests");
  const tc = useTranslations("interests.categories");
  const tp = useTranslations("interests.presets");
  const id = `${base}-c${index}`;
  const at = `categories.${index}`;
  const errorOf = (field: string): VocabularyFieldError | undefined => errors.get(`${at}.${field}`);
  const errorText = (error: VocabularyFieldError | undefined): string | undefined => (error ? t(`errors.${error.key}`, error.params) : undefined);
  const rowErrors = [...errors.keys()].filter((path) => path === at || path.startsWith(`${at}.`));
  const weight = parseWeight(draft.weight);
  const weightError = errorText(errorOf("weight"));
  const listCount = (list: readonly string[]) => list.filter((entry) => entry.trim() !== "").length;
  const words = draft.kind === "keyword" ? draft.keywords.filter((w) => w.trim() !== "") : draft.kind === "tag" ? draft.tags.filter((w) => w.trim() !== "") : [];
  const summary =
    draft.kind === "amount"
      ? t("vocabulary.countsPatterns", { patterns: listCount(draft.patterns) })
      : draft.kind === "keyword"
        ? t("vocabulary.counts", { keywords: listCount(draft.keywords), patterns: listCount(draft.patterns) })
        : t("vocabulary.countsBenefits", { tags: listCount(draft.tags), patterns: draft.tagPatterns.length });
  const bodyId = `${id}-body`;
  // A keyword category without words or patterns is found by the AI alone (or never, when jobs without rule hits are not reviewed)
  const semanticOnly = draft.kind === "keyword" && listCount(draft.keywords) === 0 && listCount(draft.patterns) === 0;

  return (
    <li
      className={cn("bg-card border-border rounded-card border-bw", rowErrors.length > 0 && "shadow-e2-bad")}
      data-testid={`category-${draft.id}`}
      data-kind={draft.kind}
      data-expanded={expanded}
    >
      <div className="grid items-center gap-x-3 gap-y-2 px-3 py-2.5 md:grid-cols-[auto_minmax(0,1fr)_auto]">
        <button type="button" className="hover:bg-soft -mx-1 flex min-w-0 cursor-pointer flex-wrap items-center gap-2 rounded-tag px-1 py-0.5 text-left" aria-expanded={expanded} aria-controls={bodyId} onClick={onToggle} data-testid={`category-toggle-${draft.id}`}>
          <ChevronRight aria-hidden className={cn("text-ink-3 size-4 shrink-0 transition-transform duration-fast", expanded && "rotate-90")} />
          <SignalTag className="shrink-0" code={categoryCode(draft.id)} icon={draft.icon.trim() === "" ? null : draft.icon} color={draft.color}>
            {name}
          </SignalTag>
          <span className="text-ink-3 font-mono text-data-sm">{tc(`kinds.${draft.kind}`)}</span>
          {draft.highValue ? <span className="bg-hi text-hi-ink rounded-tag border-bw border-border px-1.5 font-mono text-data-sm font-bold">{tc("highValueShort")}</span> : null}
          {isNew ? <span className="text-ink-2 font-mono text-data-sm">{tc("unsaved")}</span> : null}
          <span className="sr-only">{expanded ? tc("collapse") : tc("expand")}</span>
        </button>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 overflow-hidden max-md:order-last md:justify-end">
          {words.length > 0 ? (
            <>
              {words.slice(0, KEYWORDS_SHOWN).map((word) => (
                <code key={word} className="bg-soft text-ink rounded-cell px-1.5 font-mono text-data max-md:hidden">
                  {word}
                </code>
              ))}
              {words.length > KEYWORDS_SHOWN ? <span className="text-ink-3 font-mono text-data max-md:hidden">{t("weights.keywordsMore", { count: words.length - KEYWORDS_SHOWN })}</span> : null}
            </>
          ) : null}
          <span className="text-ink-3 font-mono text-data-sm">{summary}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <SegBlocks
            value={weight === null ? null : Math.min(weight / scale.max, 1) * 100}
            cells={WEIGHT_CELLS}
            tone={signalColorClasses(draft.color).tone}
            label={false}
            ariaLabel={t("weights.scale", { tier: name, value: weight === null ? "—" : weight, max: scale.max })}
          />
          <b className="font-display text-num-s w-8 text-right" aria-hidden>
            +{weight ?? "—"}
          </b>
          <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={tc("moveUp", { name })} onClick={() => onMove(-1)} data-testid={`category-up-${draft.id}`}>
            <ArrowUp aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" disabled={index === total - 1} aria-label={tc("moveDown", { name })} onClick={() => onMove(1)} data-testid={`category-down-${draft.id}`}>
            <ArrowDown aria-hidden />
          </Button>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={tc("delete", { name })} onClick={onDelete} data-testid={`category-delete-${draft.id}`}>
            <Trash2 aria-hidden />
          </Button>
        </span>
      </div>

      {expanded ? (
        <div id={bodyId} className="border-grid flex flex-col gap-4 border-t-bw px-3 py-3" data-testid={`category-body-${draft.id}`}>
          <p className="text-ink-2 text-body-sm">
            {tc(`kindHints.${draft.kind}`)} <span className="text-ink-3 font-mono text-data-sm">id: {draft.id}</span>
          </p>
          {errorOf("kind") ? (
            <p role="alert" className="text-bad text-body-sm font-bold">
              {errorText(errorOf("kind"))}
            </p>
          ) : null}
          {errorOf("id") ? (
            <p role="alert" className="text-bad text-body-sm font-bold" data-testid={`category-id-error-${draft.id}`}>
              {tc("id")}: {errorText(errorOf("id"))}
            </p>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field id={`${id}-zh`} label={tc("labelZh")} {...(errorOf("labelZh") || errorOf("label") ? { errorText: errorText(errorOf("labelZh") ?? errorOf("label")) ?? "" } : {})}>
              <Input id={`${id}-zh`} value={draft.labelZh} autoComplete="off" aria-invalid={errorOf("labelZh") || errorOf("label") ? true : undefined} aria-describedby={describedBy(`${id}-zh`, false, errorOf("labelZh") ?? errorOf("label"))} onChange={(event) => onChange({ labelZh: event.target.value })} />
            </Field>
            <Field id={`${id}-en`} label={tc("labelEn")} {...(errorOf("labelEn") ? { errorText: errorText(errorOf("labelEn")) ?? "" } : {})}>
              <Input id={`${id}-en`} value={draft.labelEn} autoComplete="off" aria-invalid={errorOf("labelEn") ? true : undefined} aria-describedby={describedBy(`${id}-en`, false, errorOf("labelEn"))} onChange={(event) => onChange({ labelEn: event.target.value })} />
            </Field>
            <Field id={`${id}-icon`} label={tc("icon")} hint={tc("iconHint", { max: MAX_CATEGORY_ICON_CHARS, code: CATEGORY_CODE_MAX_CHARS })} {...(errorOf("icon") ? { errorText: errorText(errorOf("icon")) ?? "" } : {})}>
              <Input id={`${id}-icon`} value={draft.icon} autoComplete="off" aria-invalid={errorOf("icon") ? true : undefined} aria-describedby={describedBy(`${id}-icon`, true, errorOf("icon"))} onChange={(event) => onChange({ icon: event.target.value })} />
            </Field>
          </div>

          <div className="flex flex-col gap-1.5">
            <span id={`${id}-color-label`} className="text-label font-bold">
              {tc("color")}
            </span>
            <ColorPicker labelledBy={`${id}-color-label`} value={draft.color} onChange={(color) => onChange({ color })} testId={`category-color-${draft.id}`} />
            {errorOf("color") ? (
              <p role="alert" className="text-bad text-body-sm font-bold">
                {errorText(errorOf("color"))}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-weight`} className="text-label font-bold">
              {tc("weight")}
            </label>
            <span className="flex flex-wrap items-center gap-2">
              <Input
                id={`${id}-weight`}
                size="sm"
                inputMode="decimal"
                className="w-16 font-mono tabular-nums"
                prefix="+"
                value={draft.weight}
                aria-invalid={weightError !== undefined || undefined}
                aria-describedby={describedBy(`${id}-weight`, true, weightError)}
                onChange={(event) => onChange({ weight: event.target.value })}
                data-testid={`category-weight-${draft.id}`}
              />
              <span className="border-border rounded-tag border-bw inline-flex overflow-hidden">
                <button type="button" className="bg-card hover:bg-soft active:bg-hi size-7 cursor-pointer font-extrabold" aria-label={t("weights.dec", { tier: name })} onClick={() => onChange({ weight: stepWeight(draft.weight, -1) })}>
                  <Minus aria-hidden className="mx-auto size-3.5" />
                </button>
                <button type="button" className="bg-card hover:bg-soft active:bg-hi border-border border-l-bw size-7 cursor-pointer font-extrabold" aria-label={t("weights.inc", { tier: name })} onClick={() => onChange({ weight: stepWeight(draft.weight, 1) })}>
                  <Plus aria-hidden className="mx-auto size-3.5" />
                </button>
              </span>
            </span>
            <p id={`${id}-weight-hint`} className="text-ink-2 text-body-sm">
              {tc("weightHint")}
            </p>
            {weightError ? (
              <p id={`${id}-weight-msg`} role="alert" className="text-bad text-body-sm font-bold">
                {weightError}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-3">
            <CheckField id={`${id}-high`} label={tc("highValue")} hint={tc("highValueHint")} checked={draft.highValue} onChange={(highValue) => onChange({ highValue })} testId={`category-high-${draft.id}`} />
            {draft.kind !== "tag" ? <CheckField id={`${id}-confirm`} label={tc("aiConfirm")} hint={tc("aiConfirmHint")} checked={draft.aiConfirmOnly} onChange={(aiConfirmOnly) => onChange({ aiConfirmOnly })} testId={`category-confirm-${draft.id}`} /> : null}
          </div>

          <Field id={`${id}-ai`} label={tc("aiDefinition")} hint={draft.kind === "tag" ? tc("aiDefinitionTagHint") : `${tc("aiDefinitionHint")} ${tp("definitionTip")}`} {...(errorOf("aiDefinition") ? { errorText: errorText(errorOf("aiDefinition")) ?? "" } : {})}>
            <Textarea
              id={`${id}-ai`}
              value={draft.aiDefinition}
              lang="en"
              spellCheck={false}
              className="min-h-20 text-body-sm"
              aria-invalid={errorOf("aiDefinition") ? true : undefined}
              aria-describedby={describedBy(`${id}-ai`, true, errorOf("aiDefinition"))}
              onChange={(event) => onChange({ aiDefinition: event.target.value })}
              data-testid={`category-ai-${draft.id}`}
            />
          </Field>

          {draft.kind === "keyword" ? (
            <Field id={`${id}-keywords`} label={t("fields.keywords")} hint={t("fields.keywordsHint")} {...(errorOf("keywords") ? { errorText: errorText(errorOf("keywords")) ?? "" } : {})}>
              <TagInput id={`${id}-keywords`} values={draft.keywords} onChange={(keywords) => onChange({ keywords })} invalid={errorOf("keywords") !== undefined} describedBy={describedBy(`${id}-keywords`, true, errorOf("keywords"))} />
            </Field>
          ) : null}
          {semanticOnly ? (
            aiReviewWithoutCandidates ? (
              <p className="border-border bg-soft text-ink-2 rounded-tag border-bw px-3 py-2 text-body-sm" data-testid={`category-semantic-${draft.id}`} data-tone="info">
                {tp("semanticOnly")}
              </p>
            ) : (
              <p role="alert" className="border-bad text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold" data-testid={`category-semantic-${draft.id}`} data-tone="warning">
                {tp("semanticOnlyUnreachable")}
              </p>
            )
          ) : null}
          {draft.kind === "amount" ? <p className="text-ink-2 text-body-sm">{tc("amountSettingsHint")}</p> : null}
          {draft.kind !== "tag" ? (
            <>
              <Field id={`${id}-patterns`} group label={t("fields.patterns")} hint={t("fields.patternsHint")}>
                <PatternList id={`${id}-patterns`} path={`${at}.patterns`} values={draft.patterns} errors={errors} onChange={(patterns) => onChange({ patterns })} addLabel={t("fields.addPattern")} rowLabel={t("fields.patterns")} emptyLabel={t("fields.noPatterns")} />
              </Field>
              <Field id={`${id}-exclude`} group label={t("fields.exclude")} hint={t("fields.excludeHint")}>
                <PatternList id={`${id}-exclude`} path={`${at}.exclude`} values={draft.exclude} errors={errors} onChange={(exclude) => onChange({ exclude })} addLabel={t("fields.addPattern")} rowLabel={t("fields.exclude")} emptyLabel={t("fields.noPatterns")} />
              </Field>
            </>
          ) : (
            <>
              <Field id={`${id}-tags`} label={t("fields.benefitTags")} hint={t("fields.keywordsHint")} {...(errorOf("tags") ? { errorText: errorText(errorOf("tags")) ?? "" } : {})}>
                <TagInput id={`${id}-tags`} values={draft.tags} onChange={(tags) => onChange({ tags })} invalid={errorOf("tags") !== undefined} describedBy={describedBy(`${id}-tags`, true, errorOf("tags"))} />
              </Field>
              <TagPatterns id={`${id}-tag-patterns`} at={at} rows={draft.tagPatterns} errors={errors} onChange={(tagPatterns) => onChange({ tagPatterns })} />
            </>
          )}
          {onPreview ? <CategoryPreview categoryId={draft.id} at={at} run={onPreview} /> : null}
        </div>
      ) : null}
    </li>
  );
}

function CheckField({ id, label, hint, checked, onChange, testId }: { id: string; label: string; hint: string; checked: boolean; onChange: (value: boolean) => void; testId: string }) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox id={id} checked={checked} onCheckedChange={(value) => onChange(value === true)} aria-describedby={`${id}-hint`} className="mt-0.5" data-testid={testId} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="text-label cursor-pointer font-bold">
          {label}
        </label>
        <p id={`${id}-hint`} className="text-ink-2 text-body-sm">
          {hint}
        </p>
      </div>
    </div>
  );
}

function TagPatterns({ id, at, rows, errors, onChange }: { id: string; at: string; rows: CategoryDraft["tagPatterns"]; errors: Map<string, VocabularyFieldError>; onChange: (rows: CategoryDraft["tagPatterns"]) => void }) {
  const t = useTranslations("interests");
  return (
    <Field id={id} group label={t("fields.benefitPatterns")} hint={t("fields.benefitPatternsHint")}>
      <div className="flex flex-col gap-2" data-testid={`list-${at}.tagPatterns`}>
        {rows.length === 0 ? <p className="text-ink-2 text-body-sm">{t("fields.noPatterns")}</p> : null}
        <ul className="flex flex-col gap-2">
          {rows.map((row, index) => {
            const nameError = errors.get(`${at}.tagPatterns.${index}.name`);
            const patternError = errors.get(`${at}.tagPatterns.${index}.pattern`);
            const patternMessage = patternError ? t(`errors.${patternError.key}`, patternError.params) : row.pattern.trim() !== "" && !isValidPattern(row.pattern) ? t("errors.regex") : null;
            return (
              <li key={index} className="flex flex-col gap-1">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={row.name}
                    aria-label={t("fields.benefitName", { n: index + 1 })}
                    aria-invalid={nameError !== undefined || undefined}
                    placeholder={t("fields.benefitName", { n: index + 1 })}
                    className="sm:w-56"
                    autoComplete="off"
                    onChange={(event) => onChange(rows.map((entry, i) => (i === index ? { ...entry, name: event.target.value } : entry)))}
                  />
                  <div className="flex flex-1 items-center gap-2">
                    <Input
                      value={row.pattern}
                      aria-label={t("fields.benefitPattern", { n: index + 1 })}
                      aria-invalid={patternMessage !== null || undefined}
                      placeholder={t("fields.benefitPattern", { n: index + 1 })}
                      spellCheck={false}
                      autoComplete="off"
                      className="font-mono text-xs"
                      onChange={(event) => onChange(rows.map((entry, i) => (i === index ? { ...entry, pattern: event.target.value } : entry)))}
                    />
                    <Button type="button" variant="ghost" size="icon-sm" aria-label={t("list.remove", { label: t("fields.benefitPatterns"), n: index + 1 })} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
                      <X aria-hidden />
                    </Button>
                  </div>
                </div>
                {nameError || patternMessage ? (
                  <p role="alert" className="text-destructive text-xs">
                    {nameError ? t(`errors.${nameError.key}`, nameError.params) : patternMessage}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
        <div>
          <Button type="button" variant="outline" size="xs" onClick={() => onChange([...rows, { name: "", pattern: "" }])}>
            <Plus aria-hidden /> {t("fields.addBenefit")}
          </Button>
        </div>
      </div>
    </Field>
  );
}
