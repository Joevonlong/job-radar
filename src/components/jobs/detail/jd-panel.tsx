"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { useReducedMotion } from "@/components/viz/motion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { parseJd } from "@/lib/dashboard/jd";
import type { JobLanguage } from "@/lib/db/queries/types";
import type { CategoryView } from "@/lib/signals/catalog";
import { cn } from "@/lib/utils";

import "./detail.css";
import { BREAKDOWN_MARK_CLASS, BREAKDOWN_QUOTE, FLASH_STILL_MS, GHOST_MARK_CLASS, GHOST_QUOTE, JD_JUMP_EVENT, jdMarkId, markClass, TRAP_MARK_CLASS, TRAP_QUOTE, VISA_MARK_CLASS, VISA_QUOTE, type JdJumpDetail, type JdQuoteTier } from "./marks";
import { PlaceholderBox } from "./panel";

/** `#jd-translation` in the address opens the translation tab (the "translate" button of the title area links there). */
const TRANSLATION_HASH = "#jd-translation";

interface JdPanelProps {
  description: string | null;
  /** JD language as the pipeline detected it. */
  language: JobLanguage;
  /** Signal quotes to highlight in the original text (C7: verbatim JD text). The position in this list is the quote's mark id (`jdMarkId`). */
  quotes: ReadonlyArray<{ text: string; tier: JdQuoteTier; /** Tier `trap`: hidden text or an instruction to an AI (the mark's tooltip). */ trapKind?: "hidden" | "instruction" }>;
  /** The active signal categories, in order: colours and names of the marks and the legend. */
  categories: readonly CategoryView[];
  /** Content of the translation tab (`TranslationPanel`); null when the JD is already in the target language (no tab). */
  translation: ReactNode | null;
  /** The target language's name in the interface language, for the tab ("Chinese translation"). */
  translationLanguage: string;
}

/** The job description in its original language (never translated by the UI language) with the translation tab beside it. */
export function JdPanel({ description, language, quotes, categories, translation, translationLanguage }: JdPanelProps) {
  const t = useTranslations("dashboard.detail.jd");
  const tTraps = useTranslations("aiTraps");
  const tVisa = useTranslations("visa.mark");
  const tGhost = useTranslations("ghostJobs.jdMark");
  const [tab, setTab] = useState("original");
  const reduced = useReducedMotion();
  // a jump asked for while the translation tab is open waits until the original is on screen
  const [jump, setJump] = useState<{ index: number; nonce: number } | null>(null);
  const nonce = useRef(0);
  // `other` / `unknown`: no language badge or lang attribute (nothing is guessed)
  const known = language === "en" || language === "de";
  const hasTranslation = translation !== null;
  const showTranslation = useCallback(() => {
    if (hasTranslation) setTab("translation");
  }, [hasTranslation]);

  useEffect(() => {
    function onJump(event: Event) {
      const detail = event instanceof CustomEvent ? (event.detail as JdJumpDetail | undefined) : undefined;
      if (!detail || !Number.isInteger(detail.index)) return;
      nonce.current += 1;
      setTab("original");
      setJump({ index: detail.index, nonce: nonce.current });
    }
    function onHash() {
      if (window.location.hash === TRANSLATION_HASH) showTranslation();
    }
    onHash();
    window.addEventListener(JD_JUMP_EVENT, onJump);
    window.addEventListener("hashchange", onHash);
    return () => {
      window.removeEventListener(JD_JUMP_EVENT, onJump);
      window.removeEventListener("hashchange", onHash);
    };
  }, [showTranslation]);

  useEffect(() => {
    if (jump === null || tab !== "original") return;
    const mark = document.getElementById(jdMarkId(jump.index));
    if (!mark) return;
    mark.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "center" });
    mark.classList.remove("jr-flash");
    void mark.offsetWidth; // restart the animation when the same mark is asked for twice
    mark.classList.add("jr-flash");
    const done = () => mark.classList.remove("jr-flash");
    // a still outline for reduced motion (no animation to wait for), the animation's end otherwise
    const timer = reduced ? window.setTimeout(done, FLASH_STILL_MS) : null;
    if (!reduced) mark.addEventListener("animationend", done, { once: true });
    return () => {
      if (timer !== null) window.clearTimeout(timer);
      mark.removeEventListener("animationend", done);
    };
  }, [jump, tab, reduced]);

  const blocks = description ? parseJd(description, quotes.map((q) => q.text)) : [];

  return (
    <Tabs id="jd-translation" value={tab} onValueChange={setTab} className="scroll-mt-20 gap-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <TabsList aria-label={t("tabsLabel")}>
          <TabsTrigger value="original">{known ? t("originalIn", { language: language.toUpperCase() }) : t("original")}</TabsTrigger>
          {translation === null ? null : <TabsTrigger value="translation">{t("translation", { language: translationLanguage })}</TabsTrigger>}
        </TabsList>
        {quotes.length > 0 && tab === "original" ? (
          <p className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs" data-testid="jd-legend">
            <span>{t("legend")}</span>
            {categories
              .filter((category) => quotes.some((q) => q.tier === category.id))
              .map((category) => (
                <mark key={category.id} className={cn("rounded-cell px-1", markClass(category.color))} title={category.label} data-tier={category.id}>
                  {category.kind === "tag" ? "+" : (category.code ?? category.icon ?? category.label)}
                </mark>
              ))}
            {quotes.some((q) => q.tier === BREAKDOWN_QUOTE) ? (
              <mark className={cn("bg-transparent px-1 text-inherit", BREAKDOWN_MARK_CLASS)} data-testid="jd-legend-breakdown">
                {t("legendBreakdown")}
              </mark>
            ) : null}
            {quotes.some((q) => q.tier === TRAP_QUOTE) ? (
              <mark className={TRAP_MARK_CLASS} data-testid="jd-legend-trap">
                {tTraps("mark.legend")}
              </mark>
            ) : null}
            {quotes.some((q) => q.tier === VISA_QUOTE) ? (
              <mark className={cn("bg-transparent px-1 text-inherit", VISA_MARK_CLASS)} data-testid="jd-legend-visa">
                {tVisa("legend")}
              </mark>
            ) : null}
            {quotes.some((q) => q.tier === GHOST_QUOTE) ? (
              <mark className={cn("bg-transparent px-1 text-inherit", GHOST_MARK_CLASS)} data-testid="jd-legend-ghost">
                {tGhost("legend")}
              </mark>
            ) : null}
          </p>
        ) : null}
      </div>
      {/* Kept mounted as well: a jump from a signal tag finds its mark even while the translation tab is open. */}
      <TabsContent value="original" forceMount className="data-[state=inactive]:hidden">
        {blocks.length === 0 ? (
          <PlaceholderBox testId="jd-empty">{t("empty")}</PlaceholderBox>
        ) : (
          <div className="max-w-[72ch] [overflow-wrap:anywhere]" lang={known ? language : undefined} data-testid="jd-body">
            {blocks.map((block, index) => {
              if (block.type === "heading") {
                return (
                  <h3 key={index} className="mt-4 font-semibold first:mt-0">
                    {block.text}
                  </h3>
                );
              }
              if (block.type === "list") {
                return (
                  <ul key={index} className="mt-1.5 flex flex-col gap-1">
                    {block.items.map((segments, itemIndex) => (
                      <li key={itemIndex} className="before:bg-muted-foreground relative pl-4 before:absolute before:top-[0.7em] before:left-[3px] before:size-1 before:rounded-full">
                        <Segments categories={categories} segments={segments} quotes={quotes} />
                      </li>
                    ))}
                  </ul>
                );
              }
              return (
                <p key={index} className="mt-3 first:mt-0">
                  <Segments categories={categories} segments={block.segments} quotes={quotes} />
                </p>
              );
            })}
          </div>
        )}
        <p className="text-muted-foreground mt-3 text-xs">{t("originalNote")}</p>
      </TabsContent>
      {/* Kept mounted (hidden when inactive): a running translation survives a switch to the original tab. */}
      {translation === null ? null : (
        <TabsContent value="translation" forceMount className="data-[state=inactive]:hidden">
          {translation}
        </TabsContent>
      )}
    </Tabs>
  );
}

function Segments({ segments, quotes, categories }: { segments: Array<{ text: string; quote?: number; bold?: boolean }>; quotes: JdPanelProps["quotes"]; categories: JdPanelProps["categories"] }) {
  const t = useTranslations("dashboard.detail.jd");
  const tTraps = useTranslations("aiTraps.mark");
  const tVisa = useTranslations("visa.mark");
  const tGhost = useTranslations("ghostJobs.jdMark");
  return (
    <>
      {segments.map((segment, index) => {
        const quote = segment.quote === undefined ? undefined : quotes[segment.quote];
        const text = segment.bold ? <strong className="font-semibold">{segment.text}</strong> : segment.text;
        if (!quote) return <span key={index}>{text}</span>;
        if (quote.tier === TRAP_QUOTE) {
          return (
            <mark key={index} id={jdMarkId(segment.quote as number)} data-quote-index={segment.quote} title={tTraps(quote.trapKind === "instruction" ? "instruction" : "hidden")} className={cn("scroll-mt-24", TRAP_MARK_CLASS)} data-tier="trap" data-testid="jd-trap-mark">
              {text}
            </mark>
          );
        }
        if (quote.tier === VISA_QUOTE) {
          return (
            <mark key={index} id={jdMarkId(segment.quote as number)} data-quote-index={segment.quote} title={tVisa("title")} className={cn("scroll-mt-24 bg-transparent text-inherit", VISA_MARK_CLASS)} data-tier="visa" data-testid="jd-visa-mark">
              {text}
            </mark>
          );
        }
        if (quote.tier === GHOST_QUOTE) {
          return (
            <mark key={index} id={jdMarkId(segment.quote as number)} data-quote-index={segment.quote} title={tGhost("title")} className={cn("scroll-mt-24 bg-transparent text-inherit", GHOST_MARK_CLASS)} data-tier="ghost" data-testid="jd-ghost-mark">
              {text}
            </mark>
          );
        }
        const breakdown = quote.tier === BREAKDOWN_QUOTE;
        const category = categories.find((c) => c.id === quote.tier);
        return (
          <mark key={index} id={jdMarkId(segment.quote as number)} data-quote-index={segment.quote} title={breakdown ? t("breakdownMark") : (category?.label ?? quote.tier)} className={cn("scroll-mt-24", breakdown ? ["rounded-cell bg-transparent text-inherit", BREAKDOWN_MARK_CLASS] : ["rounded-cell px-0.5", markClass(category?.color ?? "neutral")])} data-tier={quote.tier}>
            {text}
          </mark>
        );
      })}
    </>
  );
}
