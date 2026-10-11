"use client";

import { ArrowDown, ArrowUp, CheckCircle2, CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { TriggerButton } from "@/components/control/trigger-button";
import { Field, describedBy } from "@/components/profile/fields";
import { useModelText } from "@/components/settings/field-control";
import { modelChoices } from "@/components/settings/model-options";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DocLink } from "@/components/ui/doc-link";
import { Select } from "@/components/ui/select";
import { AI_PROVIDER_KINDS, type AiProviderIdChoice, type AiProviderKindChoice } from "@/lib/config/ai-options";
import { cliDefaultView, modelName } from "@/lib/settings/catalog-view";
import type { AiInput } from "@/lib/setup/inputs";
import type { AiProviderChoice, SetupView } from "@/lib/setup/view";

import { EnvPresenceList } from "./env-presence";
import { StepFrame } from "./step-frame";
import { useStep } from "./use-step";

type ProviderDraft = { enabled: boolean; model: string; strongModel: string | null };

/** The global order with every kind once: the file's order first, then the kinds it leaves out. */
function fullOrder(order: readonly AiProviderKindChoice[]): AiProviderKindChoice[] {
  return [...order, ...AI_PROVIDER_KINDS.filter((kind) => !order.includes(kind))];
}

/** Step 6: which AI providers run, in which order, with which models; key presence and a test per provider. */
export function StepAi({ view }: { view: SetupView["ai"] }) {
  const t = useTranslations("setup.ai");
  const tSettings = useTranslations("settings");
  const tVendor = useTranslations("settings.ai.vendor");
  const tAccess = useTranslations("settings.ai.accessShort");
  const modelText = useModelText(tSettings);
  const { pending, save, skip, errors, formError } = useStep("ai");
  const [order, setOrder] = useState<AiProviderKindChoice[]>(() => fullOrder(view.order));
  const [providers, setProviders] = useState<Record<string, ProviderDraft>>(() => Object.fromEntries(view.providers.map((p) => [p.id, { enabled: p.enabled, model: p.model, strongModel: p.strongModel }])));

  if (view.providers.length === 0) {
    return (
      <StepFrame step="ai" pending={pending} formError={formError} onSkip={skip} onSubmit={() => undefined} disabled>
        <p role="alert" className="text-body-sm font-bold text-bad">
          {t("unreadable")}
        </p>
      </StepFrame>
    );
  }

  const nameOf = (p: AiProviderChoice): string => `${tVendor(p.vendor)} · ${tAccess(p.access)}`;
  const kindName = (kind: AiProviderKindChoice): string => {
    if (kind === "api") return t("apiLayer");
    const provider = view.providers.find((p) => p.id === kind);
    return provider ? nameOf(provider) : kind;
  };
  const move = (index: number, delta: -1 | 1): void => {
    const next = [...order];
    const target = index + delta;
    const a = next[index];
    const b = next[target];
    if (a === undefined || b === undefined) return;
    next[index] = b;
    next[target] = a;
    setOrder(next);
  };
  const update = (id: AiProviderIdChoice, patch: Partial<ProviderDraft>): void => {
    const current = providers[id];
    if (current) setProviders({ ...providers, [id]: { ...current, ...patch } });
  };
  const submit = (): void => {
    const input: AiInput = {
      order,
      providers: Object.fromEntries(
        view.providers.map((p) => {
          const d = providers[p.id] ?? { enabled: p.enabled, model: p.model, strongModel: p.strongModel };
          return [p.id, { enabled: d.enabled, ...(view.catalog !== null ? { model: d.model } : {}), ...(view.catalog !== null && d.strongModel !== null ? { strong_model: d.strongModel } : {}) }];
        }),
      ),
    };
    save(input);
  };

  const worker = view.execution === "container" ? "notNeeded" : view.worker === null ? "unknown" : view.worker.online ? "online" : "offline";
  // the vendors behind the providers switched on in this form, as ticked right now (a vendor with a CLI and an API counts once)
  const vendors = [...new Set(view.providers.filter((p) => (providers[p.id]?.enabled ?? p.enabled)).map((p) => tVendor(p.vendor)))];
  const cliDefault = view.catalog === null ? null : cliDefaultView(view.catalog);

  const providerRow = (p: AiProviderChoice) => {
    const d = providers[p.id] ?? { enabled: p.enabled, model: p.model, strongModel: p.strongModel };
    const base = `setup-ai-${p.id}`;
    const modelError = errors.text(`providers.${p.id}.model`);
    const strongError = errors.text(`providers.${p.id}.strong_model`);
    const choices = modelChoices(view.catalog, p.id, d.model, modelText);
    const strongChoices = d.strongModel === null ? [] : modelChoices(view.catalog, p.id, d.strongModel, modelText);
    return (
      <li key={p.id} className="flex flex-col gap-sp-3 px-sp-3 py-sp-3" data-testid="setup-ai-provider" data-provider={p.id}>
        <div className="flex flex-wrap items-center gap-sp-2">
          <Checkbox id={`${base}-use`} checked={d.enabled} onCheckedChange={(checked) => update(p.id, { enabled: checked === true })} aria-label={t("use", { name: nameOf(p) })} data-testid="setup-ai-use" />
          <label htmlFor={`${base}-use`} className="cursor-pointer text-label font-bold">
            {nameOf(p)}
          </label>
          <span className="font-mono text-data-sm text-ink-3">{p.id}</span>
          <div className="ml-auto">
            <TriggerButton kind="testAi" target={p.id} />
          </div>
        </div>
        {p.key !== null ? <EnvPresenceList env={[p.key]} /> : <p className="text-body-sm text-ink-2">{t("login")}</p>}
        {view.catalog !== null ? (
          <div className="grid gap-sp-3 sm:grid-cols-2">
            <Field id={`${base}-model`} label={t("model")} errorText={modelError}>
              <Select id={`${base}-model`} value={d.model} aria-invalid={modelError ? true : undefined} aria-describedby={describedBy(`${base}-model`, false, modelError)} onChange={(event) => update(p.id, { model: event.target.value })}>
                {p.id === "codex-cli" ? <option value="">{cliDefault ? t("cliDefaultNamed", { model: modelName(cliDefault) }) : t("cliDefault")}</option> : null}
                {choices.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.text}
                  </option>
                ))}
              </Select>
            </Field>
            {d.strongModel !== null ? (
              <Field id={`${base}-strong`} label={t("strongModel")} errorText={strongError}>
                <Select id={`${base}-strong`} value={d.strongModel} aria-invalid={strongError ? true : undefined} aria-describedby={describedBy(`${base}-strong`, false, strongError)} onChange={(event) => update(p.id, { strongModel: event.target.value })}>
                  {strongChoices.map((c) => (
                    <option key={c.value} value={c.value}>
                      {c.text}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
          </div>
        ) : null}
      </li>
    );
  };

  return (
    <StepFrame step="ai" pending={pending} formError={formError} onSkip={skip} onSubmit={submit}>
      <p className="text-body-sm text-ink-2">{t("intro")}</p>
      <p className="text-body-sm text-ink-2" data-testid="setup-ai-disclosure">
        {t.rich(vendors.length > 0 ? "disclosure" : "disclosureNone", { vendors: vendors.join(", "), docs: (chunks) => <DocLink doc="aiProviders">{chunks}</DocLink> })}
      </p>
      <p className={worker === "offline" ? "flex items-start gap-sp-2 rounded-card border-bw border-border bg-soft px-sp-3 py-sp-2 text-body-sm font-bold" : "flex items-start gap-sp-2 text-body-sm"} role="status" data-testid="setup-ai-worker" data-state={worker}>
        {worker === "online" || worker === "notNeeded" ? <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-good" /> : <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />}
        {t(`worker.${worker}`)}
      </p>
      {view.catalog === null ? <p className="text-body-sm font-bold text-bad">{t("noCatalog")}</p> : null}

      <Field id="setup-ai-order" group label={t("order")} hint={t("orderHint")} errorText={errors.text("order")}>
        <ol className="flex flex-col gap-sp-3" data-testid="setup-ai-order">
          {order.map((kind, index) => (
            <li key={kind} className="flex flex-col rounded-card border-bw border-border bg-card shadow-e1" data-kind={kind}>
              <div className="flex items-center gap-sp-2 border-b-bw border-border bg-soft px-sp-3 py-sp-1">
                <span className="font-mono text-data font-bold tabular-nums">{index + 1}</span>
                <span className="text-label font-bold">{kindName(kind)}</span>
                <div className="ml-auto flex gap-1">
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === 0} aria-label={t("moveUp", { name: kindName(kind) })} onClick={() => move(index, -1)}>
                    <ArrowUp aria-hidden />
                  </Button>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={index === order.length - 1} aria-label={t("moveDown", { name: kindName(kind) })} onClick={() => move(index, 1)}>
                    <ArrowDown aria-hidden />
                  </Button>
                </div>
              </div>
              <ul className="flex flex-col divide-y-[1.5px] divide-grid">{(kind === "api" ? view.providers.filter((p) => p.access === "api") : view.providers.filter((p) => p.id === kind)).map(providerRow)}</ul>
            </li>
          ))}
        </ol>
      </Field>
    </StepFrame>
  );
}
