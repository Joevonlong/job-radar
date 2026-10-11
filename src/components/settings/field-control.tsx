"use client";

import { useFormatter, useTranslations } from "next-intl";

import { Field, TagInput } from "@/components/profile/fields";
import { RemoteScopeField } from "@/components/profile/remote-scope-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AiProviderState } from "@/lib/ai/provider-state";
import type { AiProviderIdChoice } from "@/lib/config/ai-options";
import { cliDefaultView, modelName, supportedEffortViews, type CatalogView } from "@/lib/settings/catalog-view";
import type { KeywordGroupDraft, RouteDraft, SettingsDraft, SettingsFieldError, DraftValue } from "@/lib/settings/draft";
import { accessOf, isProviderNode, vendorOf } from "@/lib/settings/ai-vendors";
import { describeCron } from "@/lib/settings/timeline";
import { fieldPrefix, fieldUnit, type FieldDef, type FieldLabelId, type SectionId } from "@/lib/settings/fields";
import type { SettingsForm } from "@/lib/settings/tabs";
import type { SettingsActionState } from "@/lib/settings/types";
import { cn } from "@/lib/utils";

import { KeywordGroupsEditor, OrderedList, RouteEditor, type ModelChoice } from "./field-editors";
import { useMarketScope } from "./market-scope";
import { modelChoices, type ModelTextHelpers } from "./model-options";
import { LOCALE_META, intlTag, isLocale } from "@/i18n/locale";

export type Translator = ReturnType<typeof useTranslations<"settings">>;

/** What the page knows about each AI provider (`claude-cli`, `anthropic`, ...); absent = nothing to say. */
export type ProviderStates = Partial<Record<string, AiProviderState>>;

/** "not configured" etc. for the providers that cannot run now; ready ones (and the "api" layer) get no note. */
export function providerNotes(t: Translator, states: ProviderStates | undefined, options: readonly string[]): Record<string, string> {
  const notes: Record<string, string> = {};
  for (const option of options) {
    const state = states?.[option];
    if (state !== undefined && state !== "ready") notes[option] = t(`providerState.${state}`);
  }
  return notes;
}

/** What the AI tab knows about the model catalog (models.yaml). */
export interface CatalogContext {
  catalog: CatalogView | null;
  /** Why the catalog cannot be read; null when it can. */
  error: string | null;
  /** The models.yaml in use, for people (`config/models.yaml`, or the user's override). */
  file: string;
}

/** Config key of the provider blocks in the draft (`providers.<key>.model`). */
export const PROVIDER_MODEL_PATH: Record<AiProviderIdChoice, string> = {
  "claude-cli": "providers.claude_cli.model",
  "codex-cli": "providers.codex_cli.model",
  anthropic: "providers.anthropic.model",
  deepseek: "providers.deepseek.model",
  mimo: "providers.mimo.model",
};
export const isProviderId = (value: string): value is AiProviderIdChoice => Object.hasOwn(PROVIDER_MODEL_PATH, value);

export const textOf = (draft: SettingsDraft, path: string): string => {
  const value = draft[path];
  return typeof value === "string" ? value : "";
};

export function useModelText(t: Translator): ModelTextHelpers {
  const format = useFormatter();
  return {
    deprecated: t("controls.deprecatedOption"),
    notInCatalog: (model) => t("controls.notInCatalog", { model }),
    number: (value) => format.number(value, { maximumFractionDigits: 4 }),
  };
}

/** The model a provider uses with the current draft, as short text: its id, or "CLI default" when codex has none chosen. */
export function currentModelText(t: Translator, draft: SettingsDraft, provider: AiProviderIdChoice): string {
  const value = textOf(draft, PROVIDER_MODEL_PATH[provider]);
  return value !== "" ? value : provider === "codex-cli" ? t("controls.cliDefaultBadge") : "";
}

/** Field errors of the last save of `tab`, keyed by field path; empty once the file has changed. */
export function settingsErrorMap(state: SettingsActionState, tab: SettingsForm, hash: string): Map<string, SettingsFieldError> {
  const map = new Map<string, SettingsFieldError>();
  if (state.status === "error" && state.tab === tab && state.baseHash === hash) {
    for (const error of state.fieldErrors) if (!map.has(error.path)) map.set(error.path, error);
  }
  return map;
}

function fieldHint(t: Translator, label: FieldLabelId): string | undefined {
  const key = `fields.${label}.hint` as const;
  // `has` is typed with the keys that exist; not every label has a hint, so ask by plain string.
  return t.has(key as never) ? t(key as never) : undefined;
}

export function sectionHint(t: Translator, id: SectionId): string | undefined {
  const key = `sectionHints.${id}` as const;
  return t.has(key as never) ? t(key as never) : undefined;
}

/** What a cron expression means, as a read-only chip beside the box: "工作日 07:00" (the box stays the editable truth). */
function CronChip({ cron }: { cron: string }) {
  const t = useTranslations("settings");
  const meaning = describeCron(cron);
  const label = (() => {
    if (meaning === null) return null;
    const days = t(`timeline.kind.${meaning.kind}`);
    const [first] = meaning.times;
    // a cron that fires many times a day is summarised, not listed
    return meaning.times.length <= CRON_TIMES_LISTED ? `${days} ${meaning.times.join(" · ")}` : `${days} ${t("cron.many", { count: meaning.times.length, first: first ?? "" })}`;
  })();
  return (
    <span
      data-testid="cron-chip"
      data-valid={meaning === null ? "false" : "true"}
      className={cn("border-border rounded-tag border-bw inline-flex w-fit items-center px-2 font-mono text-data font-semibold", meaning === null ? "bg-card text-bad border-dashed" : "bg-soft text-ink")}
    >
      {label ?? t("cron.invalid")}
    </span>
  );
}

/** More clock times than this are summarised ("12 runs from 08:00"). */
const CRON_TIMES_LISTED = 3;

export const WIDE_KINDS: ReadonlySet<FieldDef["kind"]> = new Set(["tags", "numberList", "ordered", "keywordGroups", "route"]);

interface FieldControlProps {
  def: FieldDef;
  id: string;
  value: DraftValue | undefined;
  error: SettingsFieldError | undefined;
  onChange: (value: DraftValue) => void;
  t: Translator;
  draft: SettingsDraft;
  catalog: CatalogContext | undefined;
  providerStates?: ProviderStates | undefined;
  /** The surrounding block already names the field (a task row): keep its label for screen readers only. */
  compact?: boolean;
}

/** "Anthropic · Subscription CLI", "OpenAI · API" ... for the AI provider ids of an order list (`api` = the API layer). */
export function nodeLabels(t: Translator, options: readonly string[]): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const option of options) {
    labels[option] = isProviderNode(option) ? t("ai.node", { vendor: t(`ai.vendor.${vendorOf(option)}`), access: t(`ai.accessShort.${accessOf(option)}`) }) : t("ai.apiLayer");
  }
  return labels;
}

export function FieldControl({ def, id, value, error, onChange, t, draft, catalog, providerStates, compact = false }: FieldControlProps) {
  const modelText = useModelText(t);
  const scope = useMarketScope();
  const label = t(`fields.${def.label}.label`);
  const ownHint = fieldHint(t, def.label);
  // a protected key: read-only here, edited by hand in the file
  const hint = def.locked ? [ownHint, t("controls.lockedHint")].filter((x): x is string => x !== undefined).join(" ") : ownHint;
  const errorText = error ? t(`errors.${error.key}`, error.params) : undefined;
  const describedBy = [hint ? `${id}-hint` : null, errorText ? `${id}-msg` : null].filter((x): x is string => x !== null).join(" ") || undefined;
  const invalid = errorText !== undefined;
  const asText = typeof value === "string" ? value : "";
  const unit = def.kind === "int" || def.kind === "number" ? fieldUnit(def.path) : null;
  const currency = def.kind === "int" || def.kind === "number" ? fieldPrefix(def.path) : null;
  const asList = Array.isArray(value) ? value : [];

  switch (def.kind) {
    case "bool":
      return (
        <div className="flex min-w-0 flex-col gap-1 sm:pt-7">
          <div className="flex items-center gap-3">
            <Switch id={id} checked={value === true} disabled={def.locked === true} data-locked={def.locked ? "true" : undefined} aria-describedby={describedBy} onCheckedChange={(checked) => onChange(checked)} />
            <label htmlFor={id} className="text-label cursor-pointer font-bold">
              {label}
            </label>
          </div>
          {hint ? (
            <p id={`${id}-hint`} className="text-ink-2 text-body-sm pl-14">
              {hint}
            </p>
          ) : null}
          {errorText ? (
            <p id={`${id}-msg`} role="alert" className="text-bad text-body-sm pl-14 font-bold">
              {errorText}
            </p>
          ) : null}
        </div>
      );
    case "int":
    case "number":
    case "text":
      return (
        <Field id={id} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <div className={cn(def.cron && "flex flex-wrap items-center gap-2")}>
            <Input
              id={id}
              value={asText}
              inputMode={def.kind === "int" ? "numeric" : def.kind === "number" ? "decimal" : undefined}
              autoComplete="off"
              spellCheck={false}
              readOnly={def.locked === true}
              data-locked={def.locked ? "true" : undefined}
              className={cn(def.kind !== "text" && "max-w-48 font-mono tabular-nums", def.mono && "font-mono", def.cron && "min-w-36 flex-1")}
              aria-invalid={invalid || undefined}
              aria-describedby={describedBy}
              {...(currency ? { prefix: currency } : {})}
              {...(unit ? { suffix: t(`units.${unit}`) } : {})}
              onChange={(event) => onChange(event.target.value)}
            />
            {def.cron ? <CronChip cron={asText} /> : null}
          </div>
        </Field>
      );
    case "select": {
      const notes = def.aiProviders ? providerNotes(t, providerStates, def.options ?? []) : {};
      // A codex effort offers only what the chosen model supports; a value it does not support stays visible (and is refused on save)
      const offered: readonly string[] = def.effortModelPath && catalog?.catalog ? supportedEffortViews(catalog.catalog, textOf(draft, def.effortModelPath)) : (def.options ?? []);
      const unsupported = def.effortModelPath !== undefined && asText !== "" && !offered.includes(asText);
      return (
        <Field id={id} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <Select id={id} value={asText} className={cn(def.mono && "font-mono")} aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)}>
            {def.optional && def.emptyOption ? <option value="">{t(`controls.${def.emptyOption}`)}</option> : null}
            {unsupported ? <option value={asText}>{t("controls.effortUnsupported", { effort: asText })}</option> : null}
            {offered.map((option) => (
              <option key={option} value={option} {...(def.localeOptions && isLocale(option) ? { lang: intlTag(option) } : {})}>
                {def.localeOptions && isLocale(option) ? LOCALE_META[option].name : def.optionGroup === "remoteScope" ? t(`options.remoteScope.${option as "none" | "home_country" | "worldwide"}`) : def.optionGroup === "breakdownMode" ? t(`options.breakdownMode.${option as "manual" | "auto"}`) : def.optionGroup === "aiUsageRange" ? t(`options.aiUsageRange.${option as "today" | "7d" | "30d" | "month"}`) : notes[option] ? `${option} (${notes[option]})` : option}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case "model": {
      const provider = def.provider ?? "claude-cli";
      const choices = modelChoices(catalog?.catalog, provider, asText, modelText);
      const cliDefault = catalog?.catalog ? cliDefaultView(catalog.catalog) : null;
      const emptyText = def.emptyOption === "cliDefault" && cliDefault ? t("controls.cliDefaultWith", { model: modelName(cliDefault) }) : t(`controls.${def.emptyOption ?? "cliDefault"}`);
      return (
        <Field id={id} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <Select id={id} value={asText} className="font-mono" aria-invalid={invalid || undefined} aria-describedby={describedBy} onChange={(event) => onChange(event.target.value)}>
            {def.optional ? <option value="">{emptyText}</option> : null}
            {!def.optional && asText === "" ? <option value="">{t("controls.pickModel")}</option> : null}
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.text}
              </option>
            ))}
          </Select>
        </Field>
      );
    }
    case "tags":
    case "numberList":
      return (
        <Field id={id} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <TagInput id={id} values={asList.filter((v): v is string => typeof v === "string")} invalid={invalid} describedBy={describedBy} onChange={onChange} />
        </Field>
      );
    case "ordered":
      return (
        <Field id={id} group hideLabel={def.path === "linkedin.cascade" || compact} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <OrderedList
            id={id}
            values={asList.filter((v): v is string => typeof v === "string")}
            options={def.options ?? []}
            {...(def.aiProviders ? { labels: nodeLabels(t, def.options ?? []) } : {})}
            notes={def.aiProviders ? providerNotes(t, providerStates, def.options ?? []) : {}}
            details={def.aiProviders && catalog ? orderDetails(t, draft, def.options ?? []) : {}}
            invalid={invalid}
            describedBy={describedBy}
            {...(def.optional ? { emptyNote: t("controls.inherit") } : {})}
            onChange={onChange}
          />
        </Field>
      );
    case "keywordGroups":
      return (
        <Field id={id} group hideLabel label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <KeywordGroupsEditor id={id} rows={asList.filter(isGroupRow)} invalid={invalid} describedBy={describedBy} onChange={onChange} />
        </Field>
      );
    case "remoteScope":
      return (
        <Field id={id} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <RemoteScopeField id={id} value={asText} onChange={onChange} options={scope.options} countryName={scope.countryName} invalid={invalid} describedBy={describedBy} namespace="settings" />
        </Field>
      );
    case "route": {
      const options = def.options ?? [];
      const rows = asList.filter(isRouteRow);
      const choices: Record<string, ModelChoice[]> = {};
      const defaults: Record<string, string> = {};
      for (const option of options) {
        if (!isProviderId(option)) continue;
        const row = rows.find((r) => r.provider === option);
        choices[option] = modelChoices(catalog?.catalog, option, row?.model ?? "", modelText);
        defaults[option] = currentModelText(t, draft, option);
      }
      return (
        <Field id={id} group hideLabel={compact} label={label} {...(hint ? { hint } : {})} {...(errorText ? { errorText } : {})}>
          <RouteEditor
            id={id}
            rows={rows}
            options={options}
            {...(def.aiProviders ? { labels: nodeLabels(t, options) } : {})}
            notes={def.aiProviders ? providerNotes(t, providerStates, options) : {}}
            invalid={invalid}
            describedBy={describedBy}
            emptyNote={t("controls.inherit")}
            modelChoices={choices}
            defaultModels={defaults}
            onChange={onChange}
          />
        </Field>
      );
    }
  }
}

/** The grey line after each provider of the order lists: the model it uses now (`api` lists its providers). */
function orderDetails(t: Translator, draft: SettingsDraft, options: readonly string[]): Record<string, string> {
  const details: Record<string, string> = {};
  for (const option of options) {
    if (option === "api") {
      const order = draft["api_order"];
      details[option] = `→ ${(Array.isArray(order) ? order : []).filter((v): v is string => typeof v === "string").join(", ")}`;
    } else if (isProviderId(option)) {
      details[option] = `· ${currentModelText(t, draft, option)}`;
    }
  }
  return details;
}

function isGroupRow(value: unknown): value is KeywordGroupDraft {
  return typeof value === "object" && value !== null && "keywords" in value;
}
function isRouteRow(value: unknown): value is RouteDraft {
  return typeof value === "object" && value !== null && "provider" in value;
}

/**
 * A changed field is marked in yellow: text boxes and selects take the fill, anything else (lists, switches)
 * gets a bar at its left edge.
 */
export const DIRTY_INPUT = "[&_input:not([type=checkbox])]:bg-warn [&_input:not([type=checkbox])]:text-on-signal [&_select]:bg-warn [&_select]:text-on-signal [&_[data-slot=input-group]]:bg-warn [&_[data-slot=input-suffix]]:text-on-signal";
export const DIRTY_BAR = "rounded-tag pl-3 shadow-[inset_3px_0_0_var(--warn)]";
const BAR_KINDS: ReadonlySet<FieldDef["kind"]> = new Set(["bool", "tags", "numberList", "ordered", "keywordGroups", "route"]);
export const dirtyClass = (kind: FieldDef["kind"]): string => (BAR_KINDS.has(kind) ? DIRTY_BAR : DIRTY_INPUT);

interface FieldCellProps {
  def: FieldDef;
  base: string;
  draft: SettingsDraft;
  /** Paths of the fields that differ from the saved file. */
  dirty: ReadonlySet<string>;
  errors: Map<string, SettingsFieldError>;
  patch: (path: string, value: DraftValue) => void;
  t: Translator;
  providerStates: ProviderStates | undefined;
  catalog: CatalogContext | undefined;
  compact?: boolean;
  className?: string;
}

/** One field in its grid cell: the control, with the "changed" marking when it differs from the saved file. */
export function FieldCell({ def, base, draft, dirty, errors, patch, t, providerStates, catalog, compact = false, className }: FieldCellProps) {
  const changed = dirty.has(def.path);
  return (
    <div className={cn("min-w-0", WIDE_KINDS.has(def.kind) && "sm:col-span-2", changed && dirtyClass(def.kind), className)} {...(changed ? { "data-dirty": "true" } : {})}>
      <FieldControl def={def} id={`${base}-${def.path}`} value={draft[def.path]} error={errors.get(def.path)} t={t} onChange={(value) => patch(def.path, value)} providerStates={providerStates} draft={draft} catalog={catalog} compact={compact} />
    </div>
  );
}
