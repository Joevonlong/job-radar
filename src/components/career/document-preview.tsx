"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import { findingSchema, pageCheckSchema, type DocumentFinding, type PageCheck } from "@/lib/career/render/check-result";
import { DocumentChecks } from "./document-checks";
import type { CareerDocument } from "@/lib/career/schema/document";

const hintsSchema = z.object({ findings: z.array(findingSchema), uncovered: z.array(z.string()) });
const responseSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true), html: z.string(), findings: z.array(findingSchema), uncovered: z.array(z.string()),
    exportHints: hintsSchema.optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string(),
    issues: z.array(z.object({ path: z.string().max(200), code: z.string() })).optional(),
  }),
]);
type PreviewResult = z.infer<typeof responseSchema>;
const schemaCodes = new Set([
  "invalid_type",
  "invalid_value",
  "invalid_format",
  "too_small",
  "too_big",
  "custom",
  "unrecognized_keys",
  "invalid_union",
]);

export function DocumentPreview({
  document,
  doc,
  debounceMs,
  revision = 0,
  pageCountDebounceMs,
  countRevision = 0,
  onHints,
  onPageCount,
}: {
  document: CareerDocument;
  doc: "resume" | "letter";
  debounceMs: number;
  revision?: number;
  pageCountDebounceMs: number;
  countRevision?: number;
  onHints?: (hints: { findings: DocumentFinding[]; uncovered: string[] }) => void;
  onPageCount?: (pages: number | null) => void;
}) {
  const t = useTranslations("career.documents");
  const key = JSON.stringify({ document, doc, revision });
  const [preview, setPreview] = useState<{ key: string; value: PreviewResult } | null>(null);
  const result = preview?.key === key ? preview.value : null;
  const [count, setCount] = useState<{ key: string; value: PageCheck } | null>(null);
  const pages = count?.key === key ? count.value : null;
  const pageCounter = useRef(0);
  const measured = doc === "resume" ? pages?.pages ?? null : null;
  useEffect(() => {
    onPageCount?.(measured);
  }, [measured, onPageCount]);
  const [loading, setLoading] = useState(false);
  const counter = useRef(0);
  const emptyLetter =
    doc === "letter" && !document.letter?.body.some((text) => text.included !== false && text.text.trim());
  useEffect(() => {
    const request = ++counter.current;
    const controller = new AbortController();
    if (emptyLetter && !onHints) return () => controller.abort();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/career/documents/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document, doc: emptyLetter ? "resume" : doc }),
          signal: controller.signal,
        });
        const parsed = responseSchema.safeParse(await response.json());
        if (request === counter.current && !controller.signal.aborted)
          setPreview({ key, value: parsed.success ? parsed.data : { ok: false, error: "generic" } });
        if (request === counter.current && !controller.signal.aborted && parsed.success && parsed.data.ok)
          onHints?.(parsed.data.exportHints ?? { findings: parsed.data.findings, uncovered: parsed.data.uncovered });
      } catch {
        if (request === counter.current && !controller.signal.aborted)
          setPreview({ key, value: { ok: false, error: "generic" } });
      } finally {
        if (request === counter.current && !controller.signal.aborted) setLoading(false);
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [document, doc, debounceMs, revision, emptyLetter, key, onHints]);
  useEffect(() => {
    const request = ++pageCounter.current;
    const controller = new AbortController();
    if (emptyLetter) return () => controller.abort();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/career/documents/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document, doc }),
          signal: controller.signal,
        });
        const parsed = pageCheckSchema.safeParse(await response.json());
        if (request === pageCounter.current && !controller.signal.aborted)
          setCount({ key, value: parsed.success ? parsed.data : { pages: null, budget: null, findings: [] } });
      } catch {
        if (request === pageCounter.current && !controller.signal.aborted)
          setCount({ key, value: { pages: null, budget: null, findings: [] } });
      }
    }, pageCountDebounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [document, doc, revision, emptyLetter, key, pageCountDebounceMs, countRevision]);
  return (
    <section
      aria-label={t("preview")}
      className="flex min-w-0 flex-col gap-3"
      data-testid="document-preview"
      aria-busy={!emptyLetter && loading}
    >
      {emptyLetter ? (
        <p>{t("letterHint")}</p>
      ) : (
        <>
          {loading && <p role="status">{t("loading")}</p>}
          {result?.ok === false && (
            <div role="alert">
              <p>{t(result.error === "render_invalid" ? "renderInvalid" : "status.generic")}</p>
              {result.error === "render_invalid" && result.issues && (
                <ul>
                  {result.issues.map((issue, index) => (
                    <li key={index}>
                      {t(
                        issue.code.startsWith("career.schema.") || schemaCodes.has(issue.code)
                          ? "renderField"
                          : "renderIssue",
                        { path: /^[\w.[\]-]*$/.test(issue.path) ? issue.path : "" },
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {result?.ok && (
            <iframe
              sandbox=""
              srcDoc={result.html}
              title={t("previewTitle")}
              className="h-[75vh] min-h-96 w-full min-w-0 rounded-card border-bw border-grid bg-white [color-scheme:light]"
            />
          )}
        </>
      )}
      {!emptyLetter && (
        <>
          <p role="status" className="text-body-sm text-ink-2" data-testid="document-page-count">
            {pages?.pages == null ? t("pagesUnknown") : t("pagesCount", { pages: pages.pages })}
          </p>
          {pages?.budget?.exceeded && (
            <p role="alert" className="rounded-card border-bw border-grid bg-soft p-3 font-semibold">
              {t("pagesOver", { pages: pages.pages!, budget: pages.budget.pages })}
            </p>
          )}
          {pages?.code === "pdf_checks_failed" && <p role="status">{t("checksUnavailable")}</p>}
          <DocumentChecks findings={[
            ...(result?.ok ? result.findings : []),
            ...(pages?.findings.filter((finding) => !result?.ok || !result.findings.some((item) =>
              JSON.stringify(item) === JSON.stringify(finding))) ?? []),
          ]} />
        </>
      )}
    </section>
  );
}
