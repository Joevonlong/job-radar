"use client";

import { useTranslations } from "next-intl";

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
  invalid: boolean;
  describedBy: string | undefined;
  /** Translation namespace holding `options.remoteScope.*` and `fields.remote_scope.*`. */
  namespace: "profile" | "settings";
}

/**
 * The remote scope editor (/me and /settings): a dropdown of the kind and, for "selected regions", a multi-select
 * of named regions and countries (a shared component). The value travels as the draft's scope key.
 */
export function RemoteScopeField({ id, value, onChange, options, countryName, invalid, describedBy, namespace }: RemoteScopeFieldProps) {
  const t = useTranslations(namespace);
  const tm = useTranslations("market");
  const { kind, regions } = splitScopeKey(value);
  const selectable = [...options.map((o) => ({ value: o.value, label: o.label, group: tm(`scope.groups.${o.group}`) })), ...regions.filter((r) => !options.some((o) => o.value === r)).map((r) => ({ value: r, label: r, stale: true }))];
  return (
    <div className="flex flex-col gap-2">
      <Select
        id={id}
        value={kind}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-testid="remote-scope-kind"
        onChange={(event) => onChange(joinScopeKey(event.target.value as RemoteScopeKind, event.target.value === "region" && regions.length === 0 ? ["eu"].filter((r) => options.some((o) => o.value === r)) : regions))}
      >
        {REMOTE_SCOPE_KINDS.map((option) => (
          <option key={option} value={option}>
            {option === "home_country" && countryName !== "" ? tm("scope.homeCountry", { country: countryName }) : t(`options.remoteScope.${option}`)}
          </option>
        ))}
      </Select>
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
