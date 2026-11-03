"use client";

import { ChevronDown, ChevronRight, Mail } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { ReplyRow } from "./reply-row";
import type { RepliesPanelData } from "./to-reply-views";

/**
 * The replies waiting for a decision, in a bar above the board. Closed by default so the board keeps its height; a row changes an
 * application only when its Confirm button is pressed. The newest confirmations stay listed with their Undo.
 */
export function RepliesPanel({ pending, recent, links }: RepliesPanelData) {
  const t = useTranslations("replies.panel");
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section aria-label={t("title")} data-testid="replies-panel" className="bg-card border-bw border-ink rounded-card shadow-e2 flex shrink-0 flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} data-testid="replies-toggle" className="gap-sp-2 p-sp-2 flex min-h-11 w-full items-center text-left md:min-h-0">
        <Chevron aria-hidden className="size-4 shrink-0" />
        <Mail aria-hidden className="size-4 shrink-0" />
        <span className="text-title-sm font-extrabold">{t("title")}</span>
        <span className="text-ink-2 text-body-sm min-w-0 truncate" data-testid="replies-count">
          {pending.length > 0 ? t("open", { count: pending.length }) : t("none")}
        </span>
      </button>
      {open ? (
        <div className="border-grid gap-sp-3 p-sp-2 flex max-h-[50vh] flex-col overflow-y-auto border-t-bw" data-testid="replies-body">
          <p className="text-ink-3 text-body-sm">{t("note")}</p>
          {pending.length > 0 ? (
            <ul className="gap-sp-2 flex flex-col">
              {pending.map((reply) => (
                <ReplyRow key={reply.id} reply={reply} links={links} />
              ))}
            </ul>
          ) : null}
          {recent.length > 0 ? (
            <div className="gap-sp-2 flex flex-col" data-testid="replies-recent">
              <h3 className="text-body-sm font-bold">{t("recent")}</h3>
              <ul className="gap-sp-2 flex flex-col">
                {recent.map((reply) => (
                  <ReplyRow key={reply.id} reply={reply} links={links} confirmed />
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
