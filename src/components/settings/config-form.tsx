"use client";

import { AlertTriangle, ChevronRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { EnabledBadge } from "@/components/sources/enabled-badge";
import type { AiDisclosureRow } from "@/lib/ai/disclosure";
import { changedPaths } from "@/lib/draft-diff";
import { clientFieldErrors, type SettingsDraft, type SettingsFieldError, type DraftValue } from "@/lib/settings/draft";
import { SETTINGS_SECTIONS, type SectionDef } from "@/lib/settings/fields";
import type { SettingsForm } from "@/lib/settings/tabs";
import type { QuietInput } from "@/lib/settings/timeline";
import type { CatalogView } from "@/lib/settings/catalog-view";
import type { SettingsActionState, SettingsSection } from "@/lib/settings/types";
import { cn } from "@/lib/utils";

import { AiTab } from "./ai/ai-tab";
import { FieldCell, sectionHint, settingsErrorMap, type CatalogContext, type ProviderStates, type Translator } from "./field-control";
import { SaveBar } from "./save-bar";
import { ScheduleTimeline } from "./schedule-timeline";

export { settingsErrorMap, type CatalogContext, type ProviderStates };

interface SectionViewProps {
  section: SectionDef;
  base: string;
  draft: SettingsDraft;
  /** Paths of the fields that differ from the saved file. */
  dirty: ReadonlySet<string>;
  errors: Map<string, SettingsFieldError>;
  patch: (path: string, value: DraftValue) => void;
  t: Translator;
  providerStates: ProviderStates | undefined;
  catalog: CatalogContext | undefined;
}

function SectionView({ section, base, draft, dirty, errors, patch, t, providerStates, catalog }: SectionViewProps) {
  const title = "section" in section.title ? t(`sections.${section.title.section}`) : section.title.text;
  const hint = "section" in section.title ? sectionHint(t, section.title.section) : undefined;
  const hasError = section.fields.some((def) => errors.has(def.path));
  const changedCount = section.fields.filter((def) => dirty.has(def.path)).length;
  const fields = (
    <div className="grid gap-4 sm:grid-cols-2">
      {section.fields.map((def) => (
        <FieldCell key={def.path} def={def} base={base} draft={draft} dirty={dirty} errors={errors} patch={patch} t={t} providerStates={providerStates} catalog={catalog} />
      ))}
    </div>
  );

  if (section.collapsible) {
    const enabled = section.enabledPath ? draft[section.enabledPath] === true : null;
    return (
      <details className="border-border group scroll-mt-20 rounded-card border-bw bg-card" data-testid={`section-${section.id}`} {...(hasError ? { open: true } : {})}>
        <summary className="hover:bg-soft flex cursor-pointer list-none items-center gap-2 rounded-card px-3 py-2.5 [&::-webkit-details-marker]:hidden">
          <ChevronRight aria-hidden className="text-ink-3 size-4 transition-transform group-open:rotate-90" />
          <span className={cn("text-title", "section" in section.title ? "" : "font-mono")}>{title}</span>
          {enabled !== null ? (
            <EnabledBadge enabled={enabled} className="ml-1" data-enabled={enabled ? "1" : "0"}>
              {enabled ? t("controls.channelEnabled") : t("controls.channelDisabled")}
            </EnabledBadge>
          ) : null}
          {changedCount > 0 ? (
            <Badge variant="outline" className="text-on-signal bg-warn border-border ml-auto" data-testid={`section-${section.id}-changed`}>
              {t("controls.changed")} {changedCount}
            </Badge>
          ) : null}
          {hasError ? <span aria-hidden className={cn("bg-bad size-2 rounded-full", changedCount === 0 && "ml-auto")} /> : null}
        </summary>
        <div className="flex flex-col gap-3 px-3 pt-1 pb-3">
          {hint ? <p className="text-ink-2 text-body-sm">{hint}</p> : null}
          {fields}
        </div>
      </details>
    );
  }
  return (
    <section className="flex flex-col gap-3" data-testid={`section-${section.id}`}>
      <h3 className="text-title">{title}</h3>
      {hint ? <p className="text-ink-2 text-body-sm -mt-1">{hint}</p> : null}
      {fields}
    </section>
  );
}

/**
 * After a save that failed validation, bring the first problem into view: open the section that holds it, scroll it
 * to the middle of the screen and focus the field (its message sits right under it). A problem that belongs to no
 * field (the file changed on disk, an error of the whole file) is scrolled to the same way.
 */
export function focusFirstProblem(form: HTMLElement): HTMLElement | null {
  const target = form.querySelector<HTMLElement>('[aria-invalid="true"]') ?? form.querySelector<HTMLElement>('[role="alert"]');
  if (!target) return null;
  for (let details = target.closest("details"); details; details = details.parentElement?.closest("details") ?? null) details.open = true;
  const reduceMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // (jsdom has no scrollIntoView)
  if (typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
  if (target.matches('input, select, textarea, button, [tabindex]')) target.focus({ preventScroll: true });
  return target;
}

/** What the schedule tab's timeline needs besides the draft. */
export interface TimelineContext {
  /** notify.yaml quiet hours as saved; null when they cannot be read. */
  quiet: QuietInput | null;
  /** The time zone of the saved schedule.yaml: used while the zone being typed is not valid. */
  timeZone: string;
  /** Server time at render (ISO). */
  now: string;
}

interface ConfigFormProps {
  tab: SettingsForm;
  section: SettingsSection;
  /** `schedule.yaml` etc., for the footer note. */
  file: string;
  state: SettingsActionState;
  pending: boolean;
  onSave: (draft: SettingsDraft) => void;
  /** The "runner has loaded this" line, shown in the save bar. */
  ack: ReactNode;
  /** Availability of the AI providers, marked in the provider lists and dropdowns. */
  providerStates?: ProviderStates;
  /** (AI tab) Current scores that changed scoring criteria would re-score. */
  criteriaImpact?: number | null;
  /** (AI tab) Per AI task the providers that may receive job text (null: ai.yaml cannot be read). */
  aiDisclosure?: AiDisclosureRow[] | null;
  /** The AI tab's model catalog (null = models.yaml cannot be read, see `catalogError`). */
  catalog?: CatalogView | null;
  catalogError?: string | null;
  /** The schedule tab draws its 24 h timeline above the form when this is given. */
  timeline?: TimelineContext;
}

const SCHEDULE_CYCLES = ["weekday_morning", "weekday_evening", "weekend"] as const;

/** One tab: the sections of its config file as a form with field-level errors, save and reset. */
export function ConfigForm({ tab, section, file, state, pending, onSave, ack, providerStates, catalog, catalogError, timeline, criteriaImpact = null, aiDisclosure = null }: ConfigFormProps) {
  const t = useTranslations("settings");
  const base = useId();
  const headingId = `${base}-title`;
  const initial = section.draft ?? {};
  const [draft, setDraft] = useState<SettingsDraft>(initial);
  const [, startTransition] = useTransition();
  const errors = settingsErrorMap(state, tab, section.hash);
  // problems visible in the browser: shown while typing, and the save waits (the server checks again)
  const liveErrors = clientFieldErrors(tab, draft);
  for (const error of liveErrors) errors.set(error.path, error);
  const dirtyPaths = new Set(changedPaths(draft, initial));
  const formError = state.status === "error" && state.tab === tab && state.baseHash === section.hash ? state.formError : null;
  const orphanErrors = [...errors.values()].filter((error) => error.path === "");

  const formRef = useRef<HTMLFormElement>(null);
  const failedSave = state.status === "error" && state.tab === tab && state.baseHash === section.hash ? state : null;
  // `state` is a new object for every save, so a second failed save scrolls again, even to the same field
  useEffect(() => {
    if (failedSave !== null && formRef.current) focusFirstProblem(formRef.current);
  }, [failedSave]);

  function patch(path: string, value: DraftValue) {
    setDraft((current) => ({ ...current, [path]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (liveErrors.length > 0) return;
    // Dispatching inside a transition keeps the typed values: no automatic form reset.
    startTransition(() => onSave(draft));
  }

  const text = (path: string): string => (typeof draft[path] === "string" ? draft[path] : "");
  const catalogContext: CatalogContext | undefined = tab === "ai" ? { catalog: catalog ?? null, error: catalogError ?? null, file: section.catalogFile ?? "models.yaml" } : undefined;

  return (
    <Card className="gap-4 py-4" data-testid={`settings-card-${tab}`}>
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2 id={headingId}>{t(`tabTitle.${tab}`)}</h2>
        </CardTitle>
        <CardDescription className="[overflow-wrap:anywhere]">
          {t(`tabDescription.${tab}`)} {t("tabFile", { file })}
        </CardDescription>
      </CardHeader>
      <form ref={formRef} noValidate aria-labelledby={headingId} onSubmit={handleSubmit}>
        <CardContent className="flex flex-col gap-5 px-4 md:px-5">
          {timeline ? (
            <ScheduleTimeline
              cycles={SCHEDULE_CYCLES.map((id) => ({ id, cron: text(`cycles.${id}.cron`), enabled: draft[`cycles.${id}.enabled`] === true }))}
              timeZone={text("timezone").trim()}
              fallbackTimeZone={timeline.timeZone}
              quiet={timeline.quiet}
              initialNow={timeline.now}
            />
          ) : null}
          {catalogError ? (
            <div role="alert" data-testid="catalog-error" className="border-bad bg-card text-bad flex items-start gap-2 rounded-card border-bw px-4 py-3 text-body font-bold">
              <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
              <p className="min-w-0 [overflow-wrap:anywhere]">{t("catalog.unreadable", { file: section.catalogFile ?? "models.yaml", detail: catalogError })}</p>
            </div>
          ) : null}
          {tab === "ai" ? (
            <AiTab ctx={{ base, draft, dirty: dirtyPaths, errors, patch, t, providerStates, catalog: catalogContext, criteriaImpact, aiDisclosure }} />
          ) : (
            SETTINGS_SECTIONS[tab].map((def) => <SectionView key={def.id} section={def} base={base} draft={draft} dirty={dirtyPaths} errors={errors} patch={patch} t={t} providerStates={providerStates} catalog={catalogContext} />)
          )}
          {orphanErrors.length > 0 ? (
            <div role="alert" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
              <p>{t("formErrors.otherErrors")}</p>
              <ul className="mt-1 list-disc pl-5">
                {orphanErrors.map((error) => (
                  <li key={`${error.configPath}-${error.key}`}>
                    <span className="font-mono text-data">{error.configPath}</span>: {t(`errors.${error.key}`, error.params)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {formError ? (
            <p role="alert" className="border-bad bg-card text-bad rounded-tag border-bw px-3 py-2 text-body-sm font-bold">
              {t(`formErrors.${formError}`)}
            </p>
          ) : null}
        </CardContent>
        <SaveBar
          floating
          dirtyCount={dirtyPaths.size}
          pending={pending}
          blocked={liveErrors.length > 0}
          onRevert={() => setDraft(initial)}
          status={ack}
          labels={{ dirty: (count) => t("actions.dirtyCount", { count }), clean: t("actions.clean"), save: t("actions.save"), saving: t("actions.saving"), revert: t("actions.reset") }}
        />
      </form>
    </Card>
  );
}
