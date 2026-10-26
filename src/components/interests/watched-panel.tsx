"use client";

import { Plus } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useId, useRef, useState, useTransition, type FormEvent, type KeyboardEvent } from "react";
import { toastTone } from "@/lib/toast";

import { addWatchedCompanyAction, removeWatchedCompanyAction, suggestCompaniesAction } from "@/app/interests/actions";
import { FilterChip } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { InterestsActionState, InterestsFormError, WatchedCompanyView } from "@/lib/interests/types";

/** How long typing waits before the suggestions are asked for. */
const SUGGEST_DEBOUNCE_MS = 200;

/** Watched companies: add (with autocomplete from the companies the radar has seen) and remove. */
export function WatchedPanel({ watched }: { watched: WatchedCompanyView[] }) {
  const t = useTranslations("interests.watched");
  const tErrors = useTranslations("interests.formErrors");
  const base = useId();
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<InterestsFormError | null>(null);
  const [pending, startTransition] = useTransition();
  const latest = useRef(0);

  useEffect(() => {
    const text = query.trim();
    const ticket = ++latest.current;
    if (text === "") return;
    const timer = setTimeout(() => {
      void suggestCompaniesAction(text)
        .then((names) => {
          if (ticket === latest.current) {
            setSuggestions(names);
            setActive(-1);
          }
        })
        .catch(() => {
          if (ticket === latest.current) setSuggestions([]);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  function run(task: () => Promise<InterestsActionState>, successToast: string, onDone?: () => void) {
    setError(null);
    startTransition(async () => {
      const result = await task();
      if (result.status === "saved") {
        toastTone("success", successToast);
        onDone?.();
      } else if (result.status === "error") {
        setError(result.formError ?? "invalidPayload");
      }
    });
  }

  function add(name: string) {
    const text = name.trim();
    if (text === "") return;
    run(() => addWatchedCompanyAction({ name: text }), t("addedToast", { name: text }), () => {
      setQuery("");
      setSuggestions([]);
      setOpen(false);
    });
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    add(active >= 0 && showList ? (shown[active] ?? query) : query);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" && shown.length > 0) {
      event.preventDefault();
      setOpen(true);
      setActive((index) => (index + 1) % shown.length);
    } else if (event.key === "ArrowUp" && shown.length > 0) {
      event.preventDefault();
      setActive((index) => (index <= 0 ? shown.length - 1 : index - 1));
    } else if (event.key === "Escape") {
      setOpen(false);
      setActive(-1);
    }
  }

  const listId = `${base}-list`;
  const shown = query.trim() === "" ? [] : suggestions;
  const showList = open && shown.length > 0;

  return (
    <Card className="gap-4 py-4" data-testid="watched-card" id="watched">
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 md:px-5">
        <form noValidate className="flex flex-col gap-1.5" onSubmit={onSubmit}>
          <label htmlFor={`${base}-input`} className="text-label font-bold">
            {t("add")}
          </label>
          <div className="flex items-start gap-2">
            <div className="relative min-w-0 flex-1">
              <Input
                id={`${base}-input`}
                role="combobox"
                aria-expanded={showList}
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={showList && active >= 0 ? `${base}-opt-${active}` : undefined}
                value={query}
                placeholder={t("placeholder")}
                autoComplete="off"
                maxLength={120}
                data-testid="watched-input"
                onChange={(event) => {
                  setQuery(event.target.value);
                  setOpen(true);
                  setError(null);
                }}
                onKeyDown={onKeyDown}
                onBlur={() => setOpen(false)}
              />
              {showList ? (
                <ul id={listId} role="listbox" aria-label={t("suggestions")} className="bg-popover text-popover-foreground border-border rounded-tag border-bw shadow-e2 z-dropdown absolute top-full mt-1 max-h-60 w-full overflow-auto p-1" data-testid="watched-suggestions">
                  {shown.map((name, index) => (
                    <li
                      key={name}
                      id={`${base}-opt-${index}`}
                      role="option"
                      aria-selected={index === active}
                      className="aria-selected:bg-hi hover:bg-hi cursor-pointer rounded-cell px-2 py-1.5 text-body-sm font-bold"
                      // mouse down, not click: the input's blur would close the list first
                      onMouseDown={(event) => {
                        event.preventDefault();
                        add(name);
                      }}
                    >
                      {name}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <Button type="submit" size="default" disabled={pending || query.trim() === ""} data-testid="watched-add">
              <Plus aria-hidden /> {t("addButton")}
            </Button>
          </div>
          <p className="text-ink-2 text-body-sm">{t("hint")}</p>
          {error ? (
            <p role="alert" className="text-bad text-body-sm font-bold">
              {tErrors(error)}
            </p>
          ) : null}
        </form>

        {watched.length === 0 ? (
          <p className="text-ink-2 text-body" data-testid="watched-empty">
            {t("empty")}
          </p>
        ) : (
          <ul className="flex flex-wrap gap-x-3 gap-y-2" aria-label={t("title")} data-testid="watched-list">
            {watched.map((company) => (
              <li key={company.name} className="flex max-w-full flex-col gap-0.5" data-testid="watched-item">
                <FilterChip
                  className="h-8 gap-2 pl-1"
                  removeLabel={t("remove", { name: company.name })}
                  removeDisabled={pending}
                  onRemove={() => run(() => removeWatchedCompanyAction({ name: company.name }), t("removedToast", { name: company.name }))}
                >
                  <span aria-hidden className="bg-ink text-paper grid size-6 shrink-0 place-items-center rounded-tag font-mono text-data-sm font-bold uppercase">
                    {company.name.trim().slice(0, 1)}
                  </span>
                  <span className="max-w-[16rem] truncate">{company.name}</span>
                </FilterChip>
                <span className="text-ink-3 font-mono text-data-sm">
                  {company.match ? t("matched", { name: company.match.name, count: company.match.jobCount }) : t("unmatched")}
                </span>
                {company.hasBoard ? null : (
                  <span className="text-ink-3 font-mono text-data-sm" data-testid="watched-no-board">
                    {t("noBoard")}{" "}
                    <Link href="/sources/registry" className="underline underline-offset-4">
                      {t("noBoardLink")}
                    </Link>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
