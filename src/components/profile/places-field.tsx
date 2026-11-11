"use client";

import { Plane, X } from "lucide-react";
import { useTranslations } from "next-intl";

import { lookupPlace, plannedSearches, samePlaceKey, type Place, type PlaceCandidate, type PlaceGeo } from "@/lib/market/places";
import type { ScopeOption } from "@/lib/market/view";
import type { PlaceDraft } from "@/lib/profile/draft";
import { cn } from "@/lib/utils";

import { PlacePicker } from "./place-picker";

interface PlacesFieldProps {
  id: string;
  value: readonly PlaceDraft[];
  onChange: (next: PlaceDraft[]) => void;
  /** The tables with the dictionary entries the form holds (`usePlaceGeo`). */
  geo: PlaceGeo;
  /** Called with each picked place, before `onChange`, so `geo` learns it. */
  onPick: (candidate: PlaceCandidate) => void;
  /** Regions and countries in the page's language. */
  options: readonly ScopeOption[];
  /** false when `geo` is not the market the save will use (another pack was chosen): it cannot tell what is unknown. */
  known: boolean;
  /** What the count of searches per place depends on besides the places. */
  search: { homeCity: string; homeCityId: number | null; workplace: readonly string[]; home: { country: string; countryName: string } };
  invalid?: boolean;
  describedBy?: string | undefined;
}

const WORLDWIDE = "Worldwide";

/** The name a place is shown by, in the page's language where there is one. */
function labelOf(place: Place | null, stored: string, options: readonly ScopeOption[], worldwide: string): string {
  if (place === null) return stored;
  if (place.kind === "worldwide") return worldwide;
  if (place.kind === "region") return options.find((option) => option.value === stored || option.label === place.name)?.label ?? place.name;
  return place.geoname?.name ?? options.find((option) => option.value === stored)?.label ?? place.name;
}

/**
 * The places outside the home city: each is a chip that switches between "I'd move here" (solid) and "Remote only" (dashed) on a
 * click. A city starts as a place to move to, a country or region as remote only, and Worldwide is always remote only. A place is
 * added by picking it from the list (`PlacePicker`); a saved name that neither the tables nor the dictionary know (an older or
 * hand-written file) stays, is matched as written, and is flagged to be picked again.
 */
export function PlacesField({ id, value, onChange, geo, onPick, options, known, search, invalid = false, describedBy }: PlacesFieldProps) {
  const t = useTranslations("profile.fields.places");
  const worldwide = t("worldwide");
  const idOf = (entry: PlaceDraft) => entry.id ?? null;

  const chosen = new Set([samePlaceKey(search.homeCity, geo, search.homeCityId), ...value.map((entry) => samePlaceKey(entry.place, geo, idOf(entry)))]);
  const local: PlaceCandidate[] = [
    { id: "worldwide", kind: "worldwide", place: WORLDWIDE, label: worldwide, detail: "", record: null },
    ...options.filter((option) => option.group === "regions").map((option): PlaceCandidate => ({ id: option.value, kind: "region", place: option.value, label: option.label, detail: "", record: null })),
  ];
  const add = (candidate: PlaceCandidate): void => {
    onPick(candidate);
    if (chosen.has(samePlaceKey(candidate.place, geo, candidate.id)) || chosen.has(`#${candidate.id}`)) return;
    onChange([...value, { place: candidate.place, relocate: candidate.kind === "city", id: candidate.id }]);
  };
  const unknown = known ? value.filter((entry) => lookupPlace(entry.place, geo, idOf(entry)) === null) : [];
  const planned = known ? plannedSearches({ home_city: search.homeCity, home_city_id: search.homeCityId, places: value, workplace: search.workplace }, geo, search.home) : [];

  return (
    <div className="flex flex-col gap-2" data-testid="places-field">
      <ul className="flex flex-wrap gap-1.5 empty:hidden" data-testid="places-list">
        {value.map((entry, index) => {
          const place = lookupPlace(entry.place, geo, idOf(entry));
          const label = labelOf(place, entry.place, options, worldwide);
          const fixed = place?.kind === "worldwide";
          const state = entry.relocate ? t("relocate") : t("remoteOnly");
          return (
            <li key={`${entry.place}-${entry.id ?? ""}`} className="flex items-stretch" title={place?.geoname?.kind === "city" ? [place.geoname.admin1, place.geoname.countryName].filter(Boolean).join(", ") : undefined}>
              <button
                type="button"
                disabled={fixed}
                aria-pressed={entry.relocate}
                aria-label={fixed ? t("fixed", { place: label }) : t("switch", { place: label, state })}
                data-relocate={entry.relocate}
                onClick={() => onChange(value.map((other, at) => (at === index ? { ...other, relocate: !other.relocate } : other)))}
                className={cn(
                  "inline-flex min-h-8 items-center gap-1.5 border-2 border-r-0 border-ink px-2 text-body-sm font-bold",
                  entry.relocate ? "border-solid bg-hi" : "border-dashed bg-transparent",
                  fixed ? "cursor-default" : "cursor-pointer hover:bg-hi",
                )}
              >
                {entry.relocate ? <Plane aria-hidden className="size-3.5" /> : null}
                <span>{label}</span>
                <span className="font-normal text-ink-2">{state}</span>
                {known ? <span className="font-normal text-ink-2" data-testid="place-searches">{t("searches", { count: planned.filter((search) => search.place === entry.place).length })}</span> : null}
              </button>
              <button
                type="button"
                aria-label={t("remove", { place: label })}
                onClick={() => onChange(value.filter((_, at) => at !== index))}
                className={cn("inline-flex min-h-8 cursor-pointer items-center border-2 border-ink px-1 hover:bg-hi", entry.relocate ? "border-solid" : "border-dashed")}
              >
                <X aria-hidden className="size-3.5" />
              </button>
            </li>
          );
        })}
      </ul>
      <PlacePicker
        id={id}
        kinds="any"
        local={local}
        exclude={(candidate) => chosen.has(`#${candidate.id}`) || chosen.has(samePlaceKey(candidate.place, geo, candidate.id))}
        onPick={add}
        placeholder={t("placeholder")}
        invalid={invalid}
        describedBy={describedBy}
        testId="places-input"
      />
      {unknown.map((entry) => (
        <p key={entry.place} role="status" className="text-body-sm font-bold" data-testid="places-unknown">
          {t("unknown", { name: entry.place })}
        </p>
      ))}
      <ul className="list-disc pl-5 text-body-sm text-ink-2" data-testid="places-rules">
        <li>{t("ruleMove")}</li>
        <li>{t("ruleWorldwide")}</li>
        <li>{t("ruleSearches")}</li>
      </ul>
    </div>
  );
}
