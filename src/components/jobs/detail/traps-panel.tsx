"use client";

import { useTranslations } from "next-intl";
import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { INK_LINK } from "@/components/ui/ink-link";
import type { TrapItemView, TrapPanelView } from "@/lib/traps/view";
import { cn } from "@/lib/utils";

import "./detail.css";
import { requestJdJump } from "./marks";

/** Characters of a quote shown before "expand". */
const QUOTE_CLAMP_CHARS = 180;

interface TrapsPanelProps {
  view: TrapPanelView;
  /** Index of each item's mark in the JD panel's quote list (`jdMarkId`), by item id; absent = not shown in the JD. */
  jdIndex: Readonly<Record<number, number>>;
}

function SeverityBlock({ severity }: { severity: TrapItemView["severity"] }) {
  const t = useTranslations("aiTraps.panel.severity");
  return (
    <span
      className={cn(
        "border-bw border-ink rounded-tag inline-flex h-6 shrink-0 items-center px-2 text-xs font-bold",
        severity === "trap" ? "bg-bad text-on-bad" : "jr-trap-sus",
      )}
      data-testid="trap-severity"
      data-severity={severity}
    >
      {t(severity)}
    </span>
  );
}

function Quote({ item }: { item: TrapItemView }) {
  const t = useTranslations("aiTraps.panel");
  const [open, setOpen] = useState(false);
  const id = useId();
  const long = [...item.text].length > QUOTE_CLAMP_CHARS;
  const shown = open || !long ? item.text : `${[...item.text].slice(0, QUOTE_CLAMP_CHARS).join("")}…`;
  return (
    <div className="border-border rounded-cell border-[1.5px] border-dashed px-2.5 py-2" data-testid="trap-quote">
      {item.decoded ? <span className="text-ink-3 text-data mr-1.5 font-mono">{t("decoded")}:</span> : null}
      <span id={id} className="text-data font-mono whitespace-pre-wrap [overflow-wrap:anywhere]" data-testid="trap-quote-text">
        {shown}
      </span>
      {long ? (
        <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} className={cn(INK_LINK, "ml-1.5 text-xs")} data-testid="trap-quote-toggle">
          {open ? t("collapse") : t("expand")}
        </button>
      ) : null}
    </div>
  );
}

function Item({ item, markIndex }: { item: TrapItemView; markIndex: number | undefined }) {
  const t = useTranslations("aiTraps.panel");
  const technique = t(`technique.${item.technique}`);
  const method = item.method && isKnownMethod(item.method) ? t(`method.${item.method}`) : item.method;
  const location =
    item.location.kind === "description"
      ? `${t("location.line", { line: item.location.line })} · ${t("location.removed")}`
      : (() => {
          const loc = item.location;
          const field = loc.attribute ? t("location.attribute", { field: loc.field, attribute: loc.attribute }) : loc.comment ? t("location.comment", { field: loc.field }) : loc.field;
          return loc.channelId ? t("location.rawSource", { source: loc.channelId, field }) : t("location.raw", { field });
        })();
  return (
    <li className="border-bw border-border rounded-card flex min-w-0 flex-col gap-2 p-3" data-testid="trap-item" data-severity={item.severity} data-technique={item.technique} data-source={item.source}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <SeverityBlock severity={item.severity} />
        <span className="text-title-sm min-w-0 font-semibold [overflow-wrap:anywhere]" data-testid="trap-how">
          {method ? t("how", { technique, method }) : technique}
        </span>
        <span className="text-data text-ink-3 ml-auto font-mono" data-testid="trap-source">
          {t(`source.${item.source}`)}
        </span>
      </div>
      <Quote item={item} />
      <dl className="text-data text-ink-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 font-mono">
        <dt className="sr-only">{t("quote")}</dt>
        <dd className="col-span-2 [overflow-wrap:anywhere]" data-testid="trap-location">
          {location}
        </dd>
        {item.evidence ? (
          <>
            <dt>{t("evidence")}</dt>
            <dd className="[overflow-wrap:anywhere]" data-testid="trap-evidence">
              <code>{item.evidence}</code>
            </dd>
          </>
        ) : null}
      </dl>
      {item.reason && item.verdict === "disputed" ? (
        <p className="text-body-sm text-ink-2" data-testid="trap-disputed">
          {t("disputed", { reason: item.reason })}
        </p>
      ) : item.reason ? (
        <p className="text-body-sm text-ink-2" data-testid="trap-reason">
          {t("aiReason", { reason: item.reason })}
        </p>
      ) : null}
      {markIndex !== undefined ? (
        <div>
          <Button type="button" variant="outline" size="sm" onClick={() => requestJdJump(markIndex)} data-testid="trap-jump">
            {t("jump")}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

const KNOWN_METHODS = new Set([
  "color_match",
  "display_none",
  "visibility_hidden",
  "opacity",
  "font_size",
  "offscreen",
  "clip",
  "zero_size",
  "hidden_attribute",
  "aria_hidden",
  "hidden_class",
  "tag_chars",
  "zero_width",
  "bidi_controls",
  "style",
  "script",
  "template",
  "noscript",
  "comment",
  "attribute",
] as const);
type KnownMethod = typeof KNOWN_METHODS extends Set<infer M> ? M : never;
function isKnownMethod(method: string): method is KnownMethod {
  return (KNOWN_METHODS as Set<string>).has(method);
}

/**
 * The "AI traps" panel of the detail page: every finding with its severity, how it is made, the quote, where it is, the
 * evidence, who found it (rules / AI) and the AI's reason; "show in the JD" jumps to the mark. Hidden texts the AI judged
 * harmless are folded away. The fixed note says what Job Radar did and what it leaves to the user.
 */
export function TrapsPanel({ view, jdIndex }: TrapsPanelProps) {
  const t = useTranslations("aiTraps.panel");
  return (
    <div className="flex flex-col gap-3" data-testid="traps-panel">
      {view.items.length > 0 ? (
        <ul className="flex flex-col gap-2.5" aria-label={t("listLabel")}>
          {view.items.map((item) => (
            <Item key={item.id} item={item} markIndex={jdIndex[item.id]} />
          ))}
        </ul>
      ) : null}
      {view.benign.length > 0 ? (
        <details className="group" data-testid="traps-benign">
          <summary className="text-body-sm text-ink-2 cursor-pointer select-none">{t("benign", { count: view.benign.length })}</summary>
          <ul className="mt-2 flex flex-col gap-2.5">
            {view.benign.map((item) => (
              <Item key={item.id} item={item} markIndex={jdIndex[item.id]} />
            ))}
          </ul>
        </details>
      ) : null}
      {view.scoredBeforeFound ? (
        <p className="text-body-sm border-bw border-border rounded-cell bg-soft px-3 py-2" data-testid="traps-scored-before">
          {t("scoredBefore")}
        </p>
      ) : null}
      <p className="text-body-sm text-ink-2" data-testid="traps-footer">
        {view.outcome === "trap" ? `${t("footer")} ${t("oldCaches")}` : view.outcome === "suspicious" ? t("footerSuspicious") : t("footerHarmless")}
      </p>
    </div>
  );
}
