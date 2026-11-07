"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import type { CareerDocument } from "@/lib/career/schema/document";
import type { DocumentFinding } from "@/lib/career/render/check-result";
import { DocumentChecks } from "./document-checks";

const errorSchema = z.object({ ok: z.literal(false), error: z.string() });
const dispositionSchema = z.string().regex(/^attachment;/i);

function downloadName(header: string | null): string {
  const value = dispositionSchema.parse(header);
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : /filename="([^"]+)"/i.exec(value)?.[1];
  return z.string().min(1).regex(/^[^/\\\x00-\x1f]+\.pdf$/i).parse(name);
}

export function DocumentExport({
  document,
  disabled,
  findings,
  uncovered,
  onSave,
  onBusy,
  onExported,
}: {
  document: CareerDocument;
  disabled: boolean;
  findings: DocumentFinding[];
  uncovered: string[];
  onSave: () => Promise<boolean>;
  onBusy: (busy: boolean) => void;
  onExported: (doc: "resume" | "letter") => void;
}) {
  const t = useTranslations("career.documents");
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const hasLetter = document.letter?.body.some((text) => text.included !== false && text.text.trim());
  const errorKey = (["pdf_unavailable", "pdf_busy", "pdf_failed", "pdf_too_large", "letter_missing"] as const)
    .find((key) => key === error) ?? "generic";
  const placeholders = findings.filter((finding) => /placeholder/.test(finding.code));
  async function exportPdf(doc: "resume" | "letter") {
    if (busy.current) return;
    busy.current = true;
    setExporting(true);
    onBusy(true);
    setError("");
    try {
      if (!(await onSave())) return;
      const response = await fetch(`/api/career/documents/${document.id}/pdf?doc=${doc}`, { method: "POST" });
      if (!response.ok) {
        const parsed = errorSchema.safeParse(await response.json());
        setError(response.status === 429 ? "pdf_busy" : parsed.success ? parsed.data.error : "request_failed");
        return;
      }
      z.literal("application/pdf").parse(response.headers.get("Content-Type"));
      const filename = downloadName(response.headers.get("Content-Disposition"));
      const url = URL.createObjectURL(await response.blob());
      try {
        const link = window.document.createElement("a");
        link.href = url;
        link.download = filename;
        window.document.body.append(link);
        link.click();
        link.remove();
      } finally {
        URL.revokeObjectURL(url);
      }
      onExported(doc);
    } catch {
      setError("request_failed");
    } finally {
      busy.current = false;
      setExporting(false);
      onBusy(false);
    }
  }
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={t("exportTitle")} data-testid="document-export">
      {placeholders.length > 0 && (
        <div role="alert" className="rounded-card border-bw border-grid bg-soft p-3">
          <DocumentChecks findings={placeholders} />
        </div>
      )}
      {uncovered.length > 0 && (
        <p className="break-words rounded-card border-bw border-grid bg-soft p-3" data-testid="document-font-hint">
          {t("fontHint", { characters: uncovered.join(" ") })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={disabled || exporting} onClick={() => void exportPdf("resume")}>
          {t(exporting ? "exporting" : "exportResume")}
        </Button>
        {hasLetter && (
          <Button variant="outline" disabled={disabled || exporting} onClick={() => void exportPdf("letter")}>
            {t(exporting ? "exporting" : "exportLetter")}
          </Button>
        )}
      </div>
      {error && (
        <p role="alert" className="break-words text-body-sm">
          {t(`status.${errorKey}`)}
          {error === "pdf_unavailable" && <span className="block">{t("pdfStartHint")}</span>}
        </p>
      )}
    </section>
  );
}
