"use client";

import { Plane, Plus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { lookupPlace, plannedSearches, samePlaceKey, storedPlaceName, type Place, type PlaceGeo } from "@/lib/market/places";
import type { ScopeOption } from "@/lib/market/view";
import type { PlaceDraft } from "@/lib/profile/draft";
import { cn } from "@/lib/utils";

interface PlacesFieldProps {
  id: string;
  value: readonly PlaceDraft[];
  onChange: (next: PlaceDraft[]) => void;
  geo: PlaceGeo;
  /** Regions and countries in the page's language. */
  options: readonly ScopeOption[];
  /** false when `geo` is not the market the save will use (another pack was chosen): it cannot tell what is unknown. */
  known: boolean;
  /** What the count of searches per place depends on besides the places. */
  search: { homeCity: string; workplace: readonly string[]; home: { country: string; countryName: string } };
  invalid?: boolean;
  describedBy?: string | undefined;
}

const WORLDWIDE = "Worldwide";

/** What a name in the page's language stands for: "德国" -> "DE", the shown name of Worldwide -> Worldwide, anything else as typed. */
function fromLabel(text: string, options: readonly ScopeOption[], worldwide: string): string {
  const typed = text.trim().toLocaleLowerCase();
  if (typed === worldwide.toLocaleLowerCase()) return WORLDWIDE;
  return options.find((option) => option.label.toLocaleLowerCase() === typed)?.value ?? text.trim();
}

/** The name a place is shown by, in the page's language where there is one. */
function labelOf(place: Place | null, stored: string, options: readonly ScopeOption[], worldwide: string): string {
  if (place === null) return stored;
  if (place.kind === "worldwide") return worldwide;
  if (place.kind === "city") return place.name;
  return options.find((option) => option.value === stored)?.label ?? place.name;
}

/**
 * The places outside the home city: each is a chip that switches between "I'd move here" (solid) and "Remote only" (dashed) on a
 * click. A city starts as a place to move to, a country or region as remote only, and Worldwide is always remote only. A name
 * the tables do not know is kept and warned about: no table has every town, and it is matched as written.
 */
export function PlacesField({ id, value, onChange, geo, options, known, search, invalid = false, describedBy }: PlacesFieldProps) {
  const t = useTranslations("profile.fields.places");
  const [text, setText] = useState("");
  const worldwide = t("worldwide");
  const listId = `${id}-choices`;

  const add = (): void => {
    if (text.trim() === "") return;
    const typed = fromLabel(text, options, worldwide);
    setText("");
    const key = samePlaceKey(typed, geo);
    if (key === samePlaceKey(search.homeCity, geo) || value.some((entry) => samePlaceKey(entry.place, geo) === key)) return;
    const kind = lookupPlace(typed, geo)?.kind;
    onChange([...value, { place: storedPlaceName(typed, geo), relocate: kind === undefined || kind === "city" }]);
  };

  const chosen = new Set([search.homeCity, ...value.map((entry) => entry.place)].map((place) => samePlaceKey(place, geo)));
  const cities = [...new Set(Object.values(geo.cities).map(([city]) => city))];
  const choices = [worldwide, ...options.map((option) => option.label), ...cities].filter((name) => !chosen.has(samePlaceKey(fromLabel(name, options, worldwide), geo)));
  const unknown = known ? value.filter((entry) => lookupPlace(entry.place, geo) === null) : [];
  const planned = known ? plannedSearches({ home_city: search.homeCity, places: value, workplace: search.workplace }, geo, search.home) : [];

  return (
    <div className="flex flex-col gap-2" data-testid="places-field">
      <ul className="flex flex-wrap gap-1.5 empty:hidden" data-testid="places-list">
        {value.map((entry, index) => {
          const place = lookupPlace(entry.place, geo);
          const label = labelOf(place, entry.place, options, worldwide);
          const fixed = place?.kind === "worldwide";
          const state = entry.relocate ? t("relocate") : t("remoteOnly");
          return (
            <li key={entry.place} className="flex items-stretch">
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
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          className="max-w-72"
          value={text}
          list={listId}
          placeholder={t("placeholder")}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            add();
          }}
        />
        <datalist id={listId}>
          {choices.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <Button type="button" size="sm" onClick={add}>
          <Plus aria-hidden />
          {t("add")}
        </Button>
      </div>
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
