"use client";

import { useLocale, useTranslations } from "next-intl";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";
import { createPlaceSource, placeKey, type Place as Geoname } from "@/lib/market/geo/dictionary";
import type { PlaceCandidate, PlaceGeo } from "@/lib/market/places";

/**
 * The tables of a form with the dictionary entries it holds: the saved places' (`MarketView.placeRecords`) and every place
 * picked since. `remember` adds a picked one, so the form reads it as the server will.
 */
export function usePlaceGeo(base: PlaceGeo, saved: readonly Geoname[]): { geo: PlaceGeo; remember: (candidate: PlaceCandidate) => void } {
  const [picked, setPicked] = useState<Geoname[]>([]);
  const geo = useMemo(() => ({ ...base, dictionary: createPlaceSource([...saved, ...picked]) }), [base, saved, picked]);
  const remember = (candidate: PlaceCandidate): void => {
    const record = candidate.record;
    if (record !== null) setPicked((current) => (current.some((other) => other.id === record.id) ? current : [...current, record]));
  };
  return { geo, remember };
}

interface PlacePickerProps {
  id: string;
  /** `city`: cities only (the home city); `any`: cities and countries, and the page's own choices (`local`). */
  kinds: "city" | "any";
  /** Worldwide and the regions in the page's language, listed first when their name starts with what is typed. */
  local?: readonly PlaceCandidate[];
  /** Candidates not offered (already chosen). */
  exclude?: (candidate: PlaceCandidate) => boolean;
  onPick: (candidate: PlaceCandidate) => void;
  placeholder: string;
  invalid?: boolean;
  describedBy?: string | undefined;
  testId?: string;
}

/**
 * A text box that lists the places whose name starts with what is typed, from the offline dictionary (`/api/places`), named in
 * the page's language with the region and country to tell places of one name apart. Only a listed place can be chosen: by
 * click, or with the arrow keys and Enter (Enter alone takes the first). Escape closes the list.
 */
export function PlacePicker({ id, kinds, local = [], exclude = () => false, onPick, placeholder, invalid = false, describedBy, testId }: PlacePickerProps) {
  const t = useTranslations("profile.fields.places");
  const locale = useLocale();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<PlaceCandidate[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [searching, setSearching] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const listId = `${id}-list`;

  const typed = placeKey(query);
  const localMatches = typed === "" ? [] : local.filter((choice) => placeKey(choice.label).startsWith(typed) || placeKey(choice.place).startsWith(typed));
  const shown = [...localMatches, ...found].filter((candidate) => !exclude(candidate));
  const showList = open && query.trim() !== "";

  const search = (text: string): void => {
    setQuery(text);
    setOpen(true);
    setActive(0);
    requestRef.current?.abort();
    if (text.trim() === "") {
      setFound([]);
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setSearching(true);
    fetch(`/api/places?${new URLSearchParams({ q: text, lang: locale, kinds }).toString()}`, { signal: controller.signal })
      .then((response) => (response.ok ? (response.json() as Promise<{ candidates: PlaceCandidate[] }>) : { candidates: [] }))
      .then((body) => {
        setFound(body.candidates);
        setSearching(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFound([]);
        setSearching(false);
      });
  };

  const pick = (candidate: PlaceCandidate | undefined): void => {
    if (candidate === undefined) return;
    onPick(candidate);
    requestRef.current?.abort();
    setQuery("");
    setFound([]);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" && shown.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index + 1) % shown.length);
    } else if (event.key === "ArrowUp" && shown.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index <= 0 ? shown.length - 1 : index - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (showList) pick(shown[Math.min(active, shown.length - 1)]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div className="relative max-w-96">
      <Input
        id={id}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && shown.length > 0 ? `${id}-opt-${Math.min(active, shown.length - 1)}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        maxLength={100}
        value={query}
        placeholder={placeholder}
        data-testid={testId}
        onChange={(event) => search(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t("candidates")}
          className="bg-popover text-popover-foreground border-border rounded-tag border-bw shadow-e2 z-dropdown absolute top-full mt-1 max-h-72 w-full overflow-auto p-1"
          data-testid="place-candidates"
          onMouseDown={(event) => {
            event.preventDefault();
            const option = event.target instanceof Element ? event.target.closest("[data-index]") : null;
            if (option !== null) pick(shown[Number(option.getAttribute("data-index"))]);
          }}
        >
          {shown.length === 0 ? (
            <li role="presentation" className="px-2 py-1.5 text-body-sm text-ink-2">
              {searching ? t("searching") : t("noMatch")}
            </li>
          ) : (
            shown.map((candidate, index) => (
              <li
                key={`${candidate.kind}-${candidate.id}`}
                id={`${id}-opt-${index}`}
                role="option"
                aria-selected={index === Math.min(active, shown.length - 1)}
                data-place-id={candidate.id}
                className="aria-selected:bg-hi hover:bg-hi flex cursor-pointer items-baseline gap-2 rounded-cell px-2 py-1.5 text-body-sm"
                data-index={index}
              >
                <span className="font-bold">{candidate.label}</span>
                {candidate.detail !== "" ? <span className="text-ink-2">{candidate.detail}</span> : null}
                {candidate.kind !== "city" ? <span className="ml-auto text-ink-2">{t(`kind.${candidate.kind}`)}</span> : null}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
