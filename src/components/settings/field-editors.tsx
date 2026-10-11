"use client";

import { ArrowDown, ArrowUp, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId } from "react";

import { TagInput } from "@/components/profile/fields";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import type { KeywordGroupDraft, RouteDraft } from "@/lib/settings/draft";

/** Reorderable subset of `options`: up / down / remove buttons, and a picker for what is left out. */
export function OrderedList({
  id,
  values,
  options,
  onChange,
  invalid,
  describedBy,
  emptyNote,
  notes = {},
  details = {},
  labels = {},
}: {
  id: string;
  values: string[];
  options: readonly string[];
  onChange: (next: string[]) => void;
  invalid: boolean;
  describedBy: string | undefined;
  /** Shown instead of an empty list (an optional list that falls back to a default). */
  emptyNote?: string;
  /** Per option, a short warning shown next to it ("not configured" for an AI provider that cannot run). */
  notes?: Readonly<Record<string, string>>;
  /** Per option, a grey monospace line after its name (the model the provider currently uses). */
  details?: Readonly<Record<string, string>>;
  /** Per option, the text shown instead of the raw value ("OpenAI · Subscription CLI"). */
  labels?: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("settings.controls");
  const remaining = options.filter((option) => !values.includes(option));
  const nameOf = (value: string) => labels[value] ?? value;

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= values.length) return;
    const next = [...values];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2" id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      {values.length === 0 && emptyNote ? <p className="text-muted-foreground text-sm">{emptyNote}</p> : null}
      <ol className="flex flex-col gap-1.5" data-testid={`${id}-list`}>
        {values.map((value, index) => (
          <li key={value} className="border-border bg-card flex items-center gap-2 rounded-md border py-1 pr-1 pl-3" data-value={value}>
            <span className="text-muted-foreground w-5 font-mono text-xs tabular-nums" aria-label={t("position", { n: index + 1 })}>
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate font-mono text-sm">
              {nameOf(value)}
              {details[value] ? (
                <span className="text-ink-3 ml-2 font-mono text-data" data-testid="option-detail">
                  {details[value]}
                </span>
              ) : null}
              {notes[value] ? (
                <span className="text-warning-text ml-2 font-sans text-xs" data-testid="option-note">
                  {notes[value]}
                </span>
              ) : null}
            </span>
            <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t("moveUp", { item: nameOf(value) })} onClick={() => move(index, -1)}>
              <ArrowUp aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" disabled={index === values.length - 1} aria-label={t("moveDown", { item: nameOf(value) })} onClick={() => move(index, 1)}>
              <ArrowDown aria-hidden />
            </Button>
            <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeItem", { item: nameOf(value) })} onClick={() => onChange(values.filter((v) => v !== value))}>
              <X aria-hidden />
            </Button>
          </li>
        ))}
      </ol>
      {remaining.length > 0 ? (
        <Select
          aria-label={t("addItem")}
          className="max-w-64"
          value=""
          onChange={(event) => {
            const picked = event.target.value;
            if (picked !== "") onChange([...values, picked]);
          }}
        >
          <option value="">{t("addPlaceholder")}</option>
          {remaining.map((option) => (
            <option key={option} value={option}>
              {notes[option] ? `${nameOf(option)} (${notes[option]})` : nameOf(option)}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}

/** `search.yaml: keyword_groups`: a block per group with its id and its keywords. */
export function KeywordGroupsEditor({
  id,
  rows,
  onChange,
  invalid,
  describedBy,
}: {
  id: string;
  rows: KeywordGroupDraft[];
  onChange: (next: KeywordGroupDraft[]) => void;
  invalid: boolean;
  describedBy: string | undefined;
}) {
  const t = useTranslations("settings.controls");
  const base = useId();
  return (
    <div className="flex flex-col gap-3" id={id}>
      {rows.length === 0 ? <p className="text-muted-foreground text-sm">{t("noGroups")}</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="border-border flex flex-col gap-2 rounded-md border p-3" data-testid="keyword-group">
          <div className="flex items-center gap-2">
            <Input
              className="max-w-56 font-mono"
              aria-label={t("groupId")}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              autoComplete="off"
              value={row.id}
              onChange={(event) => onChange(rows.map((r, i) => (i === index ? { ...r, id: event.target.value } : r)))}
            />
            <Button type="button" variant="ghost" size="icon-sm" className="ml-auto" aria-label={t("removeGroup", { id: row.id })} onClick={() => onChange(rows.filter((_, i) => i !== index))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
          <TagInput
            id={`${base}-${index}-keywords`}
            values={row.keywords}
            invalid={invalid}
            describedBy={describedBy}
            onChange={(keywords) => onChange(rows.map((r, i) => (i === index ? { ...r, keywords } : r)))}
          />
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => onChange([...rows, { id: "", keywords: [] }])}>
        <Plus aria-hidden /> {t("addGroup")}
      </Button>
    </div>
  );
}

/** One model choice of a dropdown: `value` goes into the draft, `text` is what the user reads. */
export interface ModelChoice {
  value: string;
  text: string;
}

/**
 * `ai.yaml: tasks.<task>`: the task's own provider order, and for each provider (except the `api` layer, which
 * expands to several) the model to use for this task. "Default" = follow the provider's own model.
 */
export function RouteEditor({
  id,
  rows,
  options,
  onChange,
  invalid,
  describedBy,
  emptyNote,
  notes = {},
  labels = {},
  modelChoices,
  defaultModels,
}: {
  id: string;
  rows: RouteDraft[];
  options: readonly string[];
  onChange: (next: RouteDraft[]) => void;
  invalid: boolean;
  describedBy: string | undefined;
  emptyNote: string;
  notes?: Readonly<Record<string, string>>;
  /** Per provider id: the text shown instead of the raw id ("OpenAI · Subscription CLI"). */
  labels?: Readonly<Record<string, string>>;
  /** Per provider id: the models its dropdown offers (without the "default" entry). */
  modelChoices: Readonly<Record<string, readonly ModelChoice[]>>;
  /** Per provider id: the model it uses by default (shown in the "default" entry). */
  defaultModels: Readonly<Record<string, string>>;
}) {
  const t = useTranslations("settings.controls");
  const remaining = options.filter((option) => !rows.some((row) => row.provider === option));
  const nameOf = (value: string) => labels[value] ?? value;

  function move(index: number, by: -1 | 1) {
    const target = index + by;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    const [item] = next.splice(index, 1);
    if (item === undefined) return;
    next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-2" id={id} aria-describedby={describedBy} aria-invalid={invalid || undefined}>
      {rows.length === 0 ? <p className="text-muted-foreground text-sm">{emptyNote}</p> : null}
      <ol className="flex flex-col gap-1.5" data-testid={`${id}-list`}>
        {rows.map((row, index) => {
          const choices = modelChoices[row.provider] ?? [];
          return (
            <li key={row.provider} className="border-border bg-card flex flex-wrap items-center gap-x-2 gap-y-1 rounded-tag border-bw py-1 pr-1 pl-3" data-value={row.provider} data-testid="route-row">
              <span className="text-muted-foreground w-5 font-mono text-xs tabular-nums" aria-label={t("position", { n: index + 1 })}>
                {index + 1}
              </span>
              <span className="min-w-0 truncate text-sm font-semibold sm:w-44">
                {nameOf(row.provider)}
                {notes[row.provider] ? (
                  <span className="text-warning-text ml-2 font-sans text-xs" data-testid="option-note">
                    {notes[row.provider]}
                  </span>
                ) : null}
              </span>
              {row.provider === "api" ? (
                <span className="text-ink-3 text-body-sm max-sm:order-last max-sm:basis-full sm:flex-1 sm:basis-48" data-testid="route-api-note">
                  {t("apiLayerModels")}
                </span>
              ) : (
                <div className="min-w-0 max-sm:order-last max-sm:basis-full sm:flex-1 sm:basis-48">
                <Select
                  aria-label={t("routeModel", { provider: nameOf(row.provider) })}
                  value={row.model}
                  className="font-mono"
                  onChange={(event) => onChange(rows.map((r, i) => (i === index ? { ...r, model: event.target.value } : r)))}
                >
                  <option value="">{t("providerDefault", { model: defaultModels[row.provider] ?? "" })}</option>
                  {choices.map((choice) => (
                    <option key={choice.value} value={choice.value}>
                      {choice.text}
                    </option>
                  ))}
                </Select>
                </div>
              )}
              <span className="ml-auto flex items-center">
                <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t("moveUp", { item: nameOf(row.provider) })} onClick={() => move(index, -1)}>
                  <ArrowUp aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" disabled={index === rows.length - 1} aria-label={t("moveDown", { item: nameOf(row.provider) })} onClick={() => move(index, 1)}>
                  <ArrowDown aria-hidden />
                </Button>
                <Button type="button" variant="ghost" size="icon-sm" aria-label={t("removeItem", { item: nameOf(row.provider) })} onClick={() => onChange(rows.filter((r) => r.provider !== row.provider))}>
                  <X aria-hidden />
                </Button>
              </span>
            </li>
          );
        })}
      </ol>
      {remaining.length > 0 ? (
        <Select
          aria-label={t("addItem")}
          className="max-w-64"
          value=""
          onChange={(event) => {
            const picked = event.target.value;
            if (picked !== "") onChange([...rows, { provider: picked, model: "" }]);
          }}
        >
          <option value="">{t("addPlaceholder")}</option>
          {remaining.map((option) => (
            <option key={option} value={option}>
              {notes[option] ? `${nameOf(option)} (${notes[option]})` : nameOf(option)}
            </option>
          ))}
        </Select>
      ) : null}
    </div>
  );
}
