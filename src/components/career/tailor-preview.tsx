"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { OutboundPreview } from "./tailor-api";

const NAMED = ["headline", "summary", "letter", "emphasis", "tone", "job"] as const;

function useBlockLabel() {
  const t = useTranslations("career.tailor.blocks");
  return (id: string) => {
    const named = NAMED.find((name) => name === id);
    if (named) return t(named);
    const requirement = /^requirement_(\d+)$/.exec(id);
    if (requirement) return t("requirement", { number: Number(requirement[1]) + 1 });
    if (id.startsWith("facts_")) return t("facts");
    return t("entry");
  };
}

/** Everything the confirm button sends: each confirmed block and the cleaned JD, exactly as the worker will rebuild them. */
export function TailorPreview({
  preview,
  replaces,
  busy,
  onConfirm,
  onCancel,
}: {
  preview: OutboundPreview;
  replaces: boolean;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations("career.tailor");
  const label = useBlockLabel();
  return (
    <section data-testid="tailor-preview" aria-label={t("previewTitle")} className="flex min-w-0 flex-col gap-3">
      <h3 className="text-title-sm font-bold">{t("previewTitle")}</h3>
      <p className="text-body-sm">{t("previewHint", { count: preview.blocks.length })}</p>
      <ol className="flex min-w-0 flex-col gap-2">
        {preview.blocks.map((block, index) => (
          <li key={`${block.id}-${index}`} data-testid="tailor-block" className="min-w-0 rounded-card border-bw border-grid p-2">
            <p className="text-label">{label(block.id)}</p>
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-data">{block.text}</pre>
          </li>
        ))}
      </ol>
      <div className="min-w-0 rounded-card border-bw border-grid p-2" data-testid="tailor-jd">
        <p className="text-label">{t("blocks.jd")}</p>
        {preview.jd_truncated && <p className="text-body-sm" role="note">{t("jdTruncated")}</p>}
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-data">{preview.jd ?? t("noJd")}</pre>
      </div>
      {replaces && <p role="alert" data-testid="tailor-replaces" className="break-words">{t("replaces")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy} onClick={onConfirm}>
          {t(replaces ? "confirmReplace" : "confirm")}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>
          {t("back")}
        </Button>
      </div>
    </section>
  );
}
