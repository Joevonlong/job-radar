"use client";

import { X } from "lucide-react";
import { useTranslations } from "next-intl";

import { lookupPlace, type PlaceCandidate, type PlaceGeo } from "@/lib/market/places";

import { PlacePicker } from "./place-picker";

interface HomeCityFieldProps {
  id: string;
  value: { home_city: string; home_city_id: number | null };
  onChange: (next: { home_city: string; home_city_id: number | null }) => void;
  /** The tables with the dictionary entries the form holds (`usePlaceGeo`). */
  geo: PlaceGeo;
  /** Called with the picked city, before `onChange`, so `geo` learns it. */
  onPick: (candidate: PlaceCandidate) => void;
  /** false when `geo` is not the market the save will use: it cannot tell what is unknown. */
  known: boolean;
  invalid?: boolean;
  describedBy?: string | undefined;
  testId: string;
}

/**
 * The home city: the chosen city with a button to clear it (empty means anywhere in the home country), and a picker to choose
 * another from the dictionary's cities. A saved name nothing knows (an older or hand-written file) is kept and flagged.
 */
export function HomeCityField({ id, value, onChange, geo, onPick, known, invalid = false, describedBy, testId }: HomeCityFieldProps) {
  const t = useTranslations("profile.fields.home_city");
  const text = value.home_city.trim();
  const place = text === "" ? null : lookupPlace(text, geo, value.home_city_id);
  const label = place?.geoname?.name ?? text;
  const detail = place?.geoname === null || place?.geoname === undefined ? "" : [place.geoname.admin1, place.geoname.countryName].filter(Boolean).join(", ");

  return (
    <div className="flex flex-col gap-2">
      {text !== "" ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex min-h-8 items-center gap-1.5 border-2 border-ink bg-hi px-2 text-body-sm font-bold" data-testid={`${testId}-value`}>
            {label}
            {detail !== "" ? <span className="font-normal text-ink-2">{detail}</span> : null}
          </span>
          <button
            type="button"
            aria-label={t("clear", { city: label })}
            onClick={() => onChange({ home_city: "", home_city_id: null })}
            className="inline-flex min-h-8 cursor-pointer items-center border-2 border-ink px-1 hover:bg-hi"
            data-testid={`${testId}-clear`}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      ) : null}
      <PlacePicker
        id={id}
        kinds="city"
        exclude={(candidate) => candidate.id === value.home_city_id}
        onPick={(candidate) => {
          onPick(candidate);
          onChange({ home_city: candidate.place, home_city_id: typeof candidate.id === "number" ? candidate.id : null });
        }}
        placeholder={text === "" ? t("placeholder") : t("change")}
        invalid={invalid}
        describedBy={describedBy}
        testId={testId}
      />
      {known && text !== "" && place === null ? (
        <p role="status" className="text-body-sm font-bold" data-testid={`${testId}-unknown`}>
          {t("unknown", { name: text })}
        </p>
      ) : null}
    </div>
  );
}
