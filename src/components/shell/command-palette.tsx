"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Briefcase, Search } from "lucide-react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { defaultFilter } from "cmdk";

import { Button } from "@/components/ui/button";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

import { Kbd } from "@/components/ui/kbd";
import { requestLeave } from "@/lib/shell/unsaved";
import { cn } from "@/lib/utils";

import { NAV_ITEMS, PALETTE_SUBPAGES } from "./nav";
import { useModifierKey } from "./use-modifier-key";

const searchResponseSchema = z.object({
  jobs: z.array(
    z.object({
      id: z.number().int(),
      title: z.string(),
      company: z.string(),
      location: z.string().nullable(),
      /** The rank value (match score + signal bonus, the number the lists and the detail page show; can pass 100); null when the job is not scored yet. */
      rank: z.number().nullable().default(null),
    }),
  ),
});
type SearchJob = z.infer<typeof searchResponseSchema>["jobs"][number];

/**
 * The rank value as the lists show it: `88/100` and a tiny bar; above 100 the number stays whole (`106/100`) with the overflow
 * mark `+6`, and the bar stops at full. Unknown ranks show a dash and no bar (never 0).
 */
export function PaletteScore({ rank, label }: { rank: number | null; label: string }) {
  if (rank === null) {
    return (
      <span className="ml-auto shrink-0 font-mono text-data-sm" data-testid="palette-score" title={label}>
        —
      </span>
    );
  }
  const value = Math.max(0, Math.round(rank));
  const over = Math.max(0, value - 100);
  const fill = Math.min(100, value);
  return (
    <span className="ml-auto flex shrink-0 items-center gap-sp-2 font-mono text-data-sm" data-testid="palette-score" data-over={over > 0 ? over : undefined}>
      <span role="meter" aria-valuemin={0} aria-valuemax={Math.max(100, value)} aria-valuenow={value} aria-valuetext={label} className="block h-1.5 w-sp-8 overflow-hidden rounded-cell border border-current">
        <i className="block h-full bg-current" style={{ width: `${fill}%` }} />
      </span>
      <span>
        {value}/100
        {over > 0 ? <span className="ml-1 font-bold">+{over}</span> : null}
      </span>
    </span>
  );
}

/** Wait this long after the last keystroke before asking the server for jobs. */
const SEARCH_DEBOUNCE_MS = 200;

export function CommandPalette({ minChars }: { minChars: number }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<{ query: string; jobs: SearchJob[] }>({ query: "", jobs: [] });
  const router = useRouter();
  // The dialog has no Trigger, so Radix cannot hand the focus back by itself: remember who had it when the palette opened.
  const returnFocusTo = useRef<HTMLElement | null>(null);
  // Opened by the keyboard shortcut with nothing focused (the origin is <body>): the search button gets the focus back instead.
  const searchButton = useRef<HTMLButtonElement | null>(null);
  const openFrom = useCallback((origin: HTMLElement | null) => {
    returnFocusTo.current = origin;
    setOpen(true);
  }, []);
  const t = useTranslations("commandPalette");
  const tNav = useTranslations("nav");
  const tSub = useTranslations("sources.subnav");
  const tShell = useTranslations("shell");
  const modifier = useModifierKey();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        if (open) setOpen(false);
        else openFrom(document.activeElement instanceof HTMLElement ? document.activeElement : null);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, openFrom]);

  // Page filtering stays local; job results keep the exact order supplied by the server.
  useEffect(() => {
    const text = query.trim();
    if (!open || text.length < minChars) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(text)}`, { signal: controller.signal })
        .then(async (response) => {
          const parsed = response.ok ? searchResponseSchema.safeParse(await response.json()) : null;
          return parsed?.success ? parsed.data.jobs : [];
        })
        .then((jobs) => { if (!controller.signal.aborted) setResult({ query: text, jobs }); })
        .catch(() => undefined);
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, minChars]);

  // rows of an earlier, longer text must not linger under a short one
  const text = query.trim();
  const canSearchJobs = text.length >= minChars;
  const shownJobs = canSearchJobs && result.query === text ? result.jobs : [];
  const pages = NAV_ITEMS.filter(({ key, href }) => !text || defaultFilter(`${tNav(key)} ${href}`, text) > 0);
  const subpages = PALETTE_SUBPAGES.filter(({ key, href }) => !text || defaultFilter(`${tSub(key)} ${href} ${key === "logs" ? tSub("logsKeywords") : ""}`, text) > 0);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      // unsaved edits on this page: the shell's dialog asks first and navigates itself if they are dropped
      if (requestLeave(href)) router.push(href);
    },
    [router],
  );

  return (
    <>
      <Button
        ref={searchButton}
        variant="outline"
        size="sm"
        className="gap-sp-2 text-ink-2 max-md:border-term-line max-md:bg-transparent max-md:text-term-ink max-md:shadow-none max-md:hover:bg-term-line sm:min-w-44 sm:justify-start"
        aria-label={`${tShell("jump")} ${modifier}K`}
        onClick={(event) => openFrom(event.currentTarget)}
      >
        <Search aria-hidden />
        <span className="hidden sm:inline">{tShell("jump")}</span>
        <Kbd aria-hidden className="ml-auto hidden max-md:border-term-ink md:inline">
          {modifier}K
        </Kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        description={t("description")}
        showCloseButton={false}
        shouldFilter={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const origin = returnFocusTo.current;
          const target = origin && origin !== document.body && origin.isConnected ? origin : searchButton.current;
          target?.focus();
        }}
        className="top-[12vh] translate-y-0 sm:max-w-[560px]"
      >
        <CommandInput placeholder={t("placeholder")} value={query} onValueChange={setQuery} />
        <CommandList>
          <CommandEmpty>{t("empty")}</CommandEmpty>
          {pages.length + subpages.length > 0 ? <CommandGroup heading={t("pagesGroup")} data-testid="palette-pages">
            {pages.map(({ key, href, icon: Icon }) => (
              <CommandItem key={key} value={`${tNav(key)} ${href}`} onSelect={() => go(href)} className="group/item">
                <Icon aria-hidden />
                <span>{tNav(key)}</span>
                <span className="ml-auto font-mono text-data-sm opacity-75">{href}</span>
              </CommandItem>
            ))}
            {subpages.map(({ key, href, icon: Icon }) => (
              <CommandItem key={key} value={`${tSub(key)} ${href} ${key === "logs" ? tSub("logsKeywords") : ""}`} onSelect={() => go(href)} className="group/item" data-testid={key === "logs" ? "activity-log-palette" : `palette-page-${key}`}>
                <Icon aria-hidden />
                <span>{tSub(key)}</span>
                <span className="ml-auto font-mono text-data-sm opacity-75">{href}</span>
              </CommandItem>
            ))}
          </CommandGroup> : null}
          {canSearchJobs ? (
            <CommandGroup heading={t("jobsGroup")} data-testid="palette-jobs">
              {shownJobs.map((job) => (
                // Filtering and ranking belong to the server.
                <CommandItem key={job.id} value={`job-${job.id}`} data-testid="palette-job" onSelect={() => go(`/jobs/${job.id}`)} className="group/item">
                  <Briefcase aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold">{job.title}</span>
                    <span className="block truncate font-mono text-data-sm opacity-75">{[job.company, job.location].filter(Boolean).join(" · ")}</span>
                  </span>
                  <PaletteScore rank={job.rank} label={job.rank === null ? t("scoreUnknown") : job.rank > 100 ? t("rankOver", { value: Math.round(job.rank), over: Math.round(job.rank) - 100 }) : t("rank", { value: Math.round(job.rank) })} />
                </CommandItem>
              ))}
              <CommandItem value="view-all-jobs" data-testid="palette-view-all" onSelect={() => go(`/jobs?q=${encodeURIComponent(text)}`)}>
                <Search aria-hidden /> {t("viewAll")}
              </CommandItem>
            </CommandGroup>
          ) : null}
        </CommandList>
        <div role="group" aria-label={t("hintsLabel")} className={cn("flex items-center gap-sp-4 border-t-bw border-border px-sp-3 py-sp-2 font-mono text-data-sm text-ink-2 max-sm:hidden")}>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>{modifier}</Kbd>
            <Kbd>K</Kbd>
            {t("hintToggle")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd>
            {t("hintMove")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Enter</Kbd>
            {t("hintOpen")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd>Esc</Kbd>
            {t("hintClose")}
          </span>
        </div>
      </CommandDialog>
    </>
  );
}
