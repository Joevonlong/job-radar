import { ChevronRight } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import type { AiProviderIdChoice } from "@/lib/config/ai-options";
import { AI_VENDORS, accessOf, configKeyOf, providerPath, vendorOf, type AiVendor } from "@/lib/settings/ai-vendors";
import { findModelView, modelName, type CatalogView } from "@/lib/settings/catalog-view";
import type { SectionDef } from "@/lib/settings/fields";
import { cn } from "@/lib/utils";

import { DIRTY_BAR, FieldCell, textOf } from "../field-control";
import { ModelCatalogTable } from "../model-catalog-table";
import { modelStatus } from "../model-options";
import { aiSection, type AiTabContext } from "./context";

/** Short text of the model a provider is set to: the catalog's display name, else the id; codex without one says "CLI default". */
function modelLabel(ctx: AiTabContext, provider: AiProviderIdChoice): string {
  const id = textOf(ctx.draft, providerPath(provider, "model"));
  if (id === "") return provider === "codex-cli" ? ctx.t("controls.cliDefaultBadge") : "";
  const catalog: CatalogView | null = ctx.catalog?.catalog ?? null;
  const found = catalog ? findModelView(catalog, provider, id) : null;
  return found ? modelName(found) : id;
}

/** "Signed in" / "key not set" and so on; a ready provider says so, one that cannot run says why. Off is the switch's job. */
function StatusBadge({ ctx, provider }: { ctx: AiTabContext; provider: AiProviderIdChoice }) {
  const state = ctx.providerStates?.[provider];
  if (state === undefined || state === "off") return null;
  const access = accessOf(provider);
  const text = state === "ready" ? ctx.t(`ai.status.ready.${access}`) : state === "unconfigured" ? ctx.t(`ai.status.unconfigured.${access}`) : ctx.t(`providerState.${state}`);
  return (
    <Badge variant={state === "ready" ? "status-good" : "gate-warn"} data-testid="provider-status" data-state={state}>
      {text}
    </Badge>
  );
}

/** One access mode of a vendor (subscription CLI or API): its own switch, state, models and the fields that belong to it. */
function ModeRow({ ctx, provider, section }: { ctx: AiTabContext; provider: AiProviderIdChoice; section: SectionDef }) {
  const { t, draft, dirty } = ctx;
  const access = accessOf(provider);
  const vendorName = t(`ai.vendor.${vendorOf(provider)}`);
  const enabledPath = providerPath(provider, "enabled");
  const enabled = draft[enabledPath] === true;
  const enabledChanged = dirty.has(enabledPath);
  const primary = section.fields.filter((def) => def.kind !== "bool" && def.advanced !== true);
  const advanced = section.fields.filter((def) => def.kind !== "bool" && def.advanced === true);
  const hasError = section.fields.some((def) => ctx.errors.has(def.path));
  const changedCount = section.fields.filter((def) => dirty.has(def.path)).length;
  const modelId = textOf(draft, providerPath(provider, "model"));
  const status = modelStatus(ctx.catalog?.catalog, provider, modelId);
  const switchId = `${ctx.base}-${enabledPath}`;
  const cell = (def: SectionDef["fields"][number]) => (
    <FieldCell key={def.path} def={def} base={ctx.base} draft={draft} dirty={dirty} errors={ctx.errors} patch={ctx.patch} t={t} providerStates={ctx.providerStates} catalog={ctx.catalog} />
  );

  return (
    <div
      data-testid={`section-${section.id}`}
      data-provider={provider}
      data-enabled={enabled ? "1" : "0"}
      className={cn("rounded-tag border-bw flex flex-col gap-3 px-3 py-3", enabled ? "border-border bg-card shadow-[inset_4px_0_0_var(--good)] pl-4" : "border-grid border-dashed bg-soft")}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className={cn("flex items-center gap-2", enabledChanged && DIRTY_BAR)} {...(enabledChanged ? { "data-dirty": "true" } : {})}>
          <Switch id={switchId} checked={enabled} aria-label={t("ai.enableMode", { vendor: vendorName, access: t(`ai.access.${access}`) })} onCheckedChange={(checked) => ctx.patch(enabledPath, checked)} />
          <label htmlFor={switchId} className="text-label cursor-pointer font-bold">
            {t(`ai.access.${access}`)}
          </label>
        </div>
        <Badge variant={enabled ? "status-on" : "status"} data-testid="provider-state">
          {enabled ? t("ai.enabled") : t("ai.disabled")}
        </Badge>
        <span className="text-ink-3 font-mono text-data">{provider}</span>
        <StatusBadge ctx={ctx} provider={provider} />
        {status === "deprecated" ? <Badge variant="gate-note">{t("controls.modelDeprecated")}</Badge> : null}
        {status === "missing" ? <Badge variant="gate-warn">{t("controls.modelMissing")}</Badge> : null}
        {changedCount > 0 || enabledChanged ? (
          <Badge variant="outline" className="text-on-signal bg-warn border-border" data-testid={`section-${section.id}-changed`}>
            {t("controls.changed")} {changedCount + (enabledChanged ? 1 : 0)}
          </Badge>
        ) : null}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{primary.map(cell)}</div>
      {advanced.length > 0 ? (
        <details className="group" data-testid={`more-${section.id}`} {...(hasError && advanced.some((def) => ctx.errors.has(def.path)) ? { open: true } : {})}>
          <summary className="text-ink-2 hover:text-ink text-body-sm flex w-fit cursor-pointer list-none items-center gap-1 font-bold [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            {t("ai.more")}
          </summary>
          <div className="mt-3 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{advanced.map(cell)}</div>
        </details>
      ) : null}
    </div>
  );
}

function VendorCard({ ctx, vendor }: { ctx: AiTabContext; vendor: AiVendor }) {
  const { t, draft } = ctx;
  const active = vendor.providers.filter((provider) => draft[providerPath(provider, "enabled")] === true);
  const catalog = ctx.catalog?.catalog ?? null;
  const catalogProviders = catalog ? vendor.providers.map((provider) => catalog.providers[provider]) : [];
  return (
    <article data-testid={`vendor-${vendor.id}`} className="border-border bg-card rounded-card border-bw flex flex-col gap-3 p-3 shadow-e2">
      <header className="flex flex-wrap items-center gap-2">
        <h4 className="font-display text-h2">{t(`ai.vendor.${vendor.id}`)}</h4>
        <ul className="flex flex-wrap items-center gap-1.5 sm:ml-auto" aria-label={t("ai.using")} data-testid="vendor-active">
          {active.length === 0 ? (
            <li>
              <Badge variant="skill-miss">{t("ai.notUsed")}</Badge>
            </li>
          ) : (
            active.map((provider) => (
              <li key={provider}>
                <Badge variant="skill-hit" data-provider={provider}>
                  {t(`ai.access.${accessOf(provider)}`)} · {modelLabel(ctx, provider)}
                </Badge>
              </li>
            ))
          )}
        </ul>
      </header>
      <div className="flex flex-col gap-3">
        {vendor.providers.map((provider) => (
          <ModeRow key={provider} ctx={ctx} provider={provider} section={aiSection(configKeyOf(provider))} />
        ))}
      </div>
      {catalogProviders.length > 0 ? (
        <details className="group border-grid border-t-[1.5px] pt-2" data-testid={`catalog-${vendor.id}`}>
          <summary className="text-ink-2 hover:text-ink text-body-sm flex w-fit cursor-pointer list-none items-center gap-1 font-bold [&::-webkit-details-marker]:hidden">
            <ChevronRight aria-hidden className="size-4 transition-transform group-open:rotate-90" />
            {t("ai.catalogToggle", { count: catalogProviders.reduce((n, p) => n + p.models.length, 0) })}
          </summary>
          <div className="mt-3 flex flex-col gap-5">
            {catalogProviders.map((provider) => (
              <div key={provider.id} className="flex flex-col gap-2">
                {vendor.providers.length > 1 ? <h5 className="text-label text-ink-2 font-bold">{t(`ai.access.${accessOf(provider.id)}`)}</h5> : null}
                <ModelCatalogTable
                  provider={provider}
                  selected={[textOf(draft, providerPath(provider.id, "model")), textOf(draft, providerPath(provider.id, "strong_model"))].filter((m) => m !== "")}
                  showEfforts={provider.id === "codex-cli"}
                  file={ctx.catalog?.file ?? "models.yaml"}
                />
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </article>
  );
}

/** Block 1: the vendors, one card each; every access mode of a vendor is a row with its own switch, models and state. */
export function ProviderVendors({ ctx }: { ctx: AiTabContext }) {
  return (
    <div className="flex flex-col gap-4" data-testid="vendors">
      {AI_VENDORS.map((vendor) => (
        <VendorCard key={vendor.id} ctx={ctx} vendor={vendor} />
      ))}
    </div>
  );
}
