"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type { CareerDocument } from "@/lib/career/schema/document";

const responseSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), html: z.string() }),
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
}: {
  document: CareerDocument;
  doc: "resume" | "letter";
  debounceMs: number;
  revision?: number;
}) {
  const t = useTranslations("career.documents");
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const counter = useRef(0);
  const emptyLetter =
    doc === "letter" && !document.letter?.body.some((text) => text.included !== false && text.text.trim());
  useEffect(() => {
    const request = ++counter.current;
    const controller = new AbortController();
    if (emptyLetter) return () => controller.abort();
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const response = await fetch("/api/career/documents/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ document, doc }),
          signal: controller.signal,
        });
        const parsed = responseSchema.safeParse(await response.json());
        if (request === counter.current && !controller.signal.aborted)
          setResult(parsed.success ? parsed.data : { ok: false, error: "generic" });
      } catch {
        if (request === counter.current && !controller.signal.aborted) setResult({ ok: false, error: "generic" });
      } finally {
        if (request === counter.current && !controller.signal.aborted) setLoading(false);
      }
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [document, doc, debounceMs, revision, emptyLetter]);
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
      <p className="text-body-sm text-ink-2">{t("pageCount")}</p>
    </section>
  );
}
