"use client";

import { useTranslations } from "next-intl";
import { useId } from "react";

import { MultiSelect } from "@/components/ui/multi-select";
import { Select } from "@/components/ui/select";
import type { ScopeOption } from "@/lib/market/view";
import { REMOTE_SCOPE_KINDS, type RemoteScopeKind } from "@/lib/profile/draft";

/** `none` | `home_country` | `worldwide` | `region:eu,CH` (the draft's remote scope key) -> kind and region tokens. */
export function splitScopeKey(key: string): { kind: RemoteScopeKind; regions: string[] } {
  if (key.startsWith("region:")) return { kind: "region", regions: key.slice("region:".length).split(",").filter((t) => t !== "") };
  return { kind: (REMOTE_SCOPE_KINDS as readonly string[]).includes(key) ? (key as RemoteScopeKind) : "none", regions: [] };
}

export function joinScopeKey(kind: RemoteScopeKind, regions: readonly string[]): string {
  return kind === "region" ? `region:${regions.join(",")}` : kind;
}

interface RemoteScopeFieldProps {
  id: string;
  value: string;
  onChange: (next: string) => void;
  /** Named regions and countries a region scope can list (the market view's `scopeOptions`). */
  options: readonly ScopeOption[];
  /** The home country's name ("Germany"), for the `home_country` choice. */
  countryName: string;
  /** The region the home country belongs to (id and name in the page's language), or null when it has none. */
  homeRegion: { id: string; name: string } | null;
  invalid: boolean;
  describedBy: string | undefined;
  /** Translation namespace holding `options.remoteScope.*` and `fields.remote_scope.*`. */
  namespace: "profile" | "settings";
}

/**
 * The remote scope editor (/me and /settings): a dropdown of the kind and, for "selected regions", a multi-select
 * of named regions and countries (a shared component). The value travels as the draft's scope key.
 */
export function RemoteScopeField({ id, value, onChange, options, countryName, homeRegion, invalid, describedBy, namespace }: RemoteScopeFieldProps) {
  const t = useTranslations(namespace);
  const tm = useTranslations("market");
  const hintId = `${useId()}-kind-hint`;
  const { kind, regions } = splitScopeKey(value);
  // "EU / Europe / EMEA" for the EU, else the region's own name
  const regionText = homeRegion === null ? "" : homeRegion.id === "eu" ? tm("scope.homeRegionShort.eu") : homeRegion.name;
  const country = countryName !== "" ? countryName : tm("scope.thisCountry");
  const homeCountryLabel = countryName === "" ? t("options.remoteScope.home_country") : homeRegion === null ? tm("scope.homeCountryRemoteNoRegion", { country }) : tm("scope.homeCountryRemote", { country, region: regionText });
  const kindHint =
    kind === "home_country" ? (homeRegion === null ? tm("scope.kindHint.home_countryNoRegion", { country }) : tm("scope.kindHint.home_country", { country, region: regionText })) : tm(`scope.kindHint.${kind}`);
  const selectable = [...options.map((o) => ({ value: o.value, label: o.label, group: tm(`scope.groups.${o.group}`) })), ...regions.filter((r) => !options.some((o) => o.value === r)).map((r) => ({ value: r, label: r, stale: true }))];
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        value={kind}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy ? `${describedBy} ${hintId}` : hintId}
        data-testid="remote-scope-kind"
        onChange={(event) => onChange(joinScopeKey(event.target.value as RemoteScopeKind, event.target.value === "region" && regions.length === 0 ? ["eu"].filter((r) => options.some((o) => o.value === r)) : regions))}
      >
        {REMOTE_SCOPE_KINDS.map((option) => (
          <option key={option} value={option}>
            {option === "home_country" ? homeCountryLabel : t(`options.remoteScope.${option}`)}
          </option>
        ))}
      </Select>
      <p id={hintId} className="text-ink-2 text-body-sm" data-testid="remote-scope-hint">
        {kindHint}
      </p>
      {kind === "region" ? (
        <MultiSelect
          layout="popover"
          label={tm("scope.regions")}
          options={selectable}
          value={regions}
          onChange={(next) => onChange(joinScopeKey("region", next))}
          searchable
          searchPlaceholder={tm("scope.search")}
          anyLabel={tm("scope.none")}
          hint={tm("scope.hint")}
          testId="remote-scope-regions"
        />
      ) : null}
    </div>
  );
}
