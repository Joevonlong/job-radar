"use client";

import { ArrowDown, ArrowUp, Trash2 } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";

import { previewDealBreakersAction, type DealBreakerPreviewResult } from "@/app/me/actions";
import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppLocale } from "@/components/viz/intl";
import { DEAL_BREAKER_LEVELS } from "@/lib/config/schemas/preferences";
import { formatInteger } from "@/lib/format/numbers";
import { DEAL_BREAKER_SCOPES, type DealBreakerDraft, type FieldError } from "@/lib/profile/draft";
import type { DraftPreviewRule } from "@/lib/profile/deal-breaker-preview";

import { DocLink } from "@/components/ui/doc-link";

import { ErrorText, Field, TagInput, describedBy } from "./fields";

/** Wait this long after the last edit before counting again (the count reads every job that is not closed). */
const PREVIEW_DEBOUNCE_MS = 500;

interface DealBreakersCardProps {
  baseId: string;
  rules: DealBreakerDraft[];
  onChange: (next: DealBreakerDraft[]) => void;
  /** Field errors of the last save (`deal_breakers.<i>.<field>`). */
  errors: Map<string, FieldError>;
  /** The user's level of the market's local language in me.yaml ("B1", "native"); null = none listed. */
  userLevel: string | null;
  /** The market's local language ("German"), and whether its step is on (a language gate needs it). */
  languageName: string;
  languageStep: boolean;
}

const EMPTY_RULE: Omit<DealBreakerDraft, "id" | "label" | "type"> = { enabled: true, at_least: "", terms: [], patterns: [], scope: "any", unless: [] };

/** A new id that no rule has: `language-gate`, `language-gate-2` …; `rule-1` … */
function freshId(rules: readonly DealBreakerDraft[], stem: string, numbered: boolean): string {
  const taken = new Set(rules.map((rule) => rule.id));
  if (!numbered && !taken.has(stem)) return stem;
  for (let n = numbered ? 1 : 2; ; n += 1) if (!taken.has(`${stem}-${n}`)) return `${stem}-${n}`;
}

function move<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** "Would veto 12 of 3,400 jobs" and three examples, or why the rule does nothing. */
function RulePreview({ preview, total, rule }: { preview: DraftPreviewRule | undefined; total: number; rule: DealBreakerDraft }) {
  const t = useTranslations("dealBreakers.preview");
  const locale = useAppLocale();
  if (preview === undefined) return <p className="text-ink-3 font-mono text-data-sm">{t("counting")}</p>;
  if (preview.status === "invalid") return <p className="text-ink-3 font-mono text-data-sm" data-testid="deal-breaker-preview" data-status="invalid">{t("invalid")}</p>;
  if (preview.status !== "ok" && preview.status !== "disabled") {
    return (
      <p className="text-bad font-mono text-data-sm font-bold" data-testid="deal-breaker-preview" data-status={preview.status}>
        {t(`status.${preview.status}`)}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid="deal-breaker-preview" data-status={preview.status} data-count={preview.count} data-total={total}>
      <p className="font-mono text-data" role="status">
        {t(rule.enabled ? "count" : "countOff", { count: preview.count, countText: formatInteger(preview.count, locale), total: formatInteger(total, locale) })}
      </p>
      {preview.samples.length > 0 ? (
        <ul className="text-ink-2 flex min-w-0 flex-col gap-0.5 text-body-sm" aria-label={t("samples")}>
          {preview.samples.map((sample) => (
            <li key={sample.jobId} className="min-w-0 truncate">
              <Link href={`/jobs/${sample.jobId}`} className={INK_LINK}>
                {sample.title}
              </Link>{" "}
              · {sample.company}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * The deal-breakers of preferences.yaml (part of the "What I want" form, saved with it): rules that veto a job in the hard
 * filter, before any AI call. Each rule shows what it would veto among the jobs in the database now (the same count as
 * `pnpm deal-breakers:check`).
 */
export function DealBreakersCard({ baseId, rules, onChange, errors, userLevel, languageName, languageStep }: DealBreakersCardProps) {
  const t = useTranslations("dealBreakers");
  const locale = useAppLocale();
  const headingId = useId();
  const [preview, setPreview] = useState<DealBreakerPreviewResult | null>(null);
  const request = useRef(0);
  const key = JSON.stringify(rules);

  useEffect(() => {
    const ticket = ++request.current;
    if (rules.length === 0) return;
    const timer = setTimeout(() => {
      previewDealBreakersAction(rules)
        .then((result) => {
          if (ticket === request.current) setPreview(result);
        })
        .catch(() => {
          if (ticket === request.current) setPreview({ status: "error", error: "unavailable" });
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the rules' content, not the array's identity: a re-render with the same rules does not count again
  }, [key]);

  function update(index: number, next: Partial<DealBreakerDraft>) {
    onChange(rules.map((rule, i) => (i === index ? { ...rule, ...next } : rule)));
  }

  const level = userLevel === null ? t("levels.none") : userLevel === "native" ? t("levels.native") : userLevel;
  const levelText = userLevel === null ? t("gate.noLevel", { language: languageName }) : t("gate.yourLevel", { language: languageName, level });

  function addGate() {
    onChange([...rules, { ...EMPTY_RULE, id: freshId(rules, "language-gate", false), label: t("defaults.gate", { language: languageName }), type: "language_gate" }]);
  }
  function addPhrase() {
    onChange([...rules, { ...EMPTY_RULE, id: freshId(rules, "rule", true), label: t("defaults.phrase"), type: "phrase" }]);
  }

  const previewRules = preview?.status === "done" ? preview.rules : null;
  const total = preview?.status === "done" ? preview.total : 0;

  return (
    <section className="border-border flex min-w-0 flex-col gap-3 rounded-card border-bw p-3 md:p-4" aria-labelledby={headingId} data-testid="deal-breakers-card">
      <div className="flex flex-col gap-1">
        <h3 id={headingId} className="text-label font-bold">
          {t("title")}
        </h3>
        <p className="text-ink-2 text-body-sm">{t("description")}</p>
        <p className="text-ink-2 text-body-sm" data-testid="deal-breakers-ai-note">
          {t.rich("aiNote", {
            criteria: (chunks) => (
              <Link href="/settings?tab=ai" className={INK_LINK}>
                {chunks}
              </Link>
            ),
          })}{" "}
          {t.rich("guide", { doc: (chunks) => <DocLink doc="dealBreakers">{chunks}</DocLink> })}
        </p>
      </div>
      <ErrorText id={`${baseId}-msg`} error={errors.get("deal_breakers")} />
      {preview?.status === "error" ? (
        <p className="text-ink-3 font-mono text-data-sm" data-testid="deal-breakers-preview-unavailable">
          {t("preview.unavailable")}
        </p>
      ) : null}
      {preview?.status === "done" && preview.partial ? (
        <p className="text-ink-3 font-mono text-data-sm" data-testid="deal-breakers-preview-partial">
          {t("preview.partial", { total: formatInteger(preview.total, locale) })}
        </p>
      ) : null}

      {rules.length === 0 ? <p className="text-ink-3 text-body-sm">{t("empty")}</p> : null}
      <ol className="flex min-w-0 flex-col gap-3">
        {rules.map((rule, index) => {
          const id = `${baseId}-${index}`;
          const err = (field: string) => errors.get(`deal_breakers.${index}.${field}`);
          const name = rule.label.trim() === "" ? rule.id : rule.label;
          return (
            <li key={index} className="border-border bg-card flex min-w-0 flex-col gap-3 rounded-card border-bw p-3" data-testid="deal-breaker" data-type={rule.type} data-enabled={rule.enabled ? "true" : "false"}>
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Switch id={`${id}-enabled`} checked={rule.enabled} onCheckedChange={(checked) => update(index, { enabled: checked })} aria-label={t("enabled", { name })} />
                <span className="font-mono text-data-sm text-ink-2 border-border rounded-tag border-bw px-1.5">{t(`types.${rule.type === "language_gate" ? "language_gate" : "phrase"}`)}</span>
                <span className="ml-auto flex items-center gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t("moveUp", { name })} onClick={() => onChange(move(rules, index, index - 1))}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === rules.length - 1} aria-label={t("moveDown", { name })} onClick={() => onChange(move(rules, index, index + 1))}>
                    <ArrowDown aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" aria-label={t("remove", { name })} data-testid="deal-breaker-remove" onClick={() => onChange(rules.filter((_, i) => i !== index))}>
                    <Trash2 aria-hidden />
                  </Button>
                </span>
              </div>
              <ErrorText id={`${id}-row-msg`} error={errors.get(`deal_breakers.${index}`) ?? err("type")} />

              <div className="grid min-w-0 gap-3 sm:grid-cols-[minmax(0,1fr)_12rem]">
                <Field id={`${id}-label`} label={t("fields.label")} error={err("label")}>
                  <Input
                    id={`${id}-label`}
                    value={rule.label}
                    autoComplete="off"
                    aria-invalid={err("label") ? true : undefined}
                    aria-describedby={describedBy(`${id}-label`, false, err("label"))}
                    onChange={(event) => update(index, { label: event.target.value })}
                  />
                </Field>
                <Field id={`${id}-id`} label={t("fields.id")} hint={t("fields.idHint")} error={err("id")}>
                  <Input
                    id={`${id}-id`}
                    value={rule.id}
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={err("id") ? true : undefined}
                    aria-describedby={describedBy(`${id}-id`, true, err("id"))}
                    onChange={(event) => update(index, { id: event.target.value })}
                  />
                </Field>
              </div>

              {rule.type === "language_gate" ? (
                <>
                  <Field id={`${id}-at-least`} label={t("fields.atLeast", { language: languageName })} hint={rule.at_least === "" ? levelText : t("gate.fixed")} error={err("at_least")}>
                    {/* the width on a wrapper: Select's own wrapper is full width and places the chevron at its edge */}
                    <div className="w-full max-w-72">
                      <Select
                        id={`${id}-at-least`}
                        value={rule.at_least}
                        aria-describedby={describedBy(`${id}-at-least`, true, err("at_least"))}
                        onChange={(event) => update(index, { at_least: event.target.value })}
                      >
                        <option value="">{t("gate.aboveMine", { level })}</option>
                        {DEAL_BREAKER_LEVELS.map((cefr) => (
                          <option key={cefr} value={cefr}>
                            {t("gate.atLeast", { level: cefr })}
                          </option>
                        ))}
                      </Select>
                    </div>
                  </Field>
                  {languageStep ? null : (
                    <p className="text-bad text-body-sm font-bold" data-testid="deal-breaker-no-language-step">
                      {t("gate.noLanguageStep")}
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Field id={`${id}-terms`} label={t("fields.terms")} hint={t("fields.termsHint")} error={err("terms")}>
                    <TagInput id={`${id}-terms`} values={rule.terms} onChange={(next) => update(index, { terms: next })} invalid={err("terms") !== undefined} describedBy={describedBy(`${id}-terms`, true, err("terms"))} />
                  </Field>
                  <Field id={`${id}-patterns`} label={t("fields.patterns")} hint={t("fields.patternsHint")} error={err("patterns")}>
                    <TagInput id={`${id}-patterns`} values={rule.patterns} onChange={(next) => update(index, { patterns: next })} invalid={err("patterns") !== undefined} describedBy={describedBy(`${id}-patterns`, true, err("patterns"))} />
                  </Field>
                  <div className="grid min-w-0 gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
                    <Field id={`${id}-scope`} label={t("fields.scope")} error={err("scope")}>
                      <Select id={`${id}-scope`} value={rule.scope} aria-describedby={describedBy(`${id}-scope`, false, err("scope"))} onChange={(event) => update(index, { scope: event.target.value })}>
                        {DEAL_BREAKER_SCOPES.map((scope) => (
                          <option key={scope} value={scope}>
                            {t(`scopes.${scope}`)}
                          </option>
                        ))}
                      </Select>
                    </Field>
                    <Field id={`${id}-unless`} label={t("fields.unless")} hint={t("fields.unlessHint")} error={err("unless")}>
                      <TagInput id={`${id}-unless`} values={rule.unless} onChange={(next) => update(index, { unless: next })} invalid={err("unless") !== undefined} describedBy={describedBy(`${id}-unless`, true, err("unless"))} />
                    </Field>
                  </div>
                </>
              )}

              {preview?.status === "error" ? null : <RulePreview preview={previewRules?.[index]} total={total} rule={rule} />}
            </li>
          );
        })}
      </ol>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" onClick={addGate} data-testid="deal-breaker-add-gate">
          {t("addGate")}
        </Button>
        <Button type="button" size="sm" onClick={addPhrase} data-testid="deal-breaker-add-phrase">
          {t("addPhrase")}
        </Button>
        <span className="text-ink-2 font-mono text-data-sm" data-testid="deal-breaker-user-level">
          {levelText}
        </span>
      </div>
      <p className="text-ink-3 font-mono text-data-sm">{t("previewOnly")}</p>
    </section>
  );
}
