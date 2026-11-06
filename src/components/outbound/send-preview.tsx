"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { editedPreview, type PreparedText } from "@/lib/outbound/preview";

export function SendPreview({ preview, busy, onChange, onPrepare, onSend, onCancel }: {
  preview: PreparedText;
  busy: boolean;
  onChange: (preview: PreparedText) => void;
  onPrepare: (input: { text: string; name: string; address: string; mode: "values" }) => Promise<boolean>;
  onSend: (text: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations("outbound");
  const id = useId();
  const editor = useRef<HTMLTextAreaElement>(null);
  const [name, setName] = useState(preview.candidates.name ?? "");
  const [address, setAddress] = useState(preview.candidates.address ?? "");
  const [valuesChanged, setValuesChanged] = useState(false);
  useEffect(() => { editor.current?.focus(); }, []);
  const boundaries = [...new Set([0, preview.text.length, ...preview.highlights.flatMap((span) => [span.start, span.end])])].filter((at) => at >= 0 && at <= preview.text.length).sort((a, b) => a - b);
  const label = (kind: string) => t(kind === "maybe_phone" ? "legend.phone" : kind === "location" ? "legend.location" : "legend.sensitive");
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={t("title")} data-testid="send-preview">
      <h3 className="text-title-sm font-bold">{t("title")}</h3>
      <p id={`${id}-warning`} className="text-body-sm">{t("warning")}</p>
      <p role="status" className="text-body-sm">{t("removed", { count: preview.removed })}</p>
      {preview.truncated && <p role="status" className="text-warning-text">{t("truncated")}</p>}
      <div className="grid min-w-0 gap-3 md:grid-cols-2">
        <label className="text-label">{t("name")}<Input value={name} autoComplete="off" disabled={busy} onChange={(event) => { setName(event.target.value); setValuesChanged(true); }} /></label>
        <label className="text-label">{t("address")}<Input value={address} autoComplete="off" disabled={busy} onChange={(event) => { setAddress(event.target.value); setValuesChanged(true); }} /></label>
      </div>
      {preview.candidates.name && <p className="text-body-sm">{t("guessed")}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy || !valuesChanged} onClick={async () => {
          if (await onPrepare({ text: preview.text, name, address, mode: "values" })) { setValuesChanged(false); requestAnimationFrame(() => editor.current?.focus()); }
        }}>{t("apply")}</Button>
        {preview.candidates.name && <Button variant="ghost" disabled={busy} onClick={() => {
          onChange(editedPreview(preview, preview.text.replaceAll("[name]", preview.candidates.name!)));
          setName(""); setValuesChanged(address !== (preview.candidates.address ?? "")); editor.current?.focus();
        }}>{t("restoreName")}</Button>}
      </div>
      {valuesChanged && <p role="status" className="text-body-sm">{t("applyFirst")}</p>}
      <label htmlFor={`${id}-text`} className="text-label">{t("text")}</label>
      <Textarea ref={editor} id={`${id}-text`} rows={10} value={preview.text} disabled={busy} autoComplete="off" aria-describedby={`${id}-warning`} onChange={(event) => onChange(editedPreview(preview, event.target.value))} data-testid="outbound-text" />
      <div className="flex flex-col gap-2" aria-label={t("highlights")}>
        <p className="text-body-sm">{t("legendTitle")}</p>
        <ul className="text-body-sm list-inside list-disc">{["maybe_phone", "location", "sensitive"].map((kind) => <li key={kind}>{label(kind)}</li>)}</ul>
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-card border-bw border-grid p-3 font-mono text-data" data-testid="outbound-highlights">
          {boundaries.slice(0, -1).map((start, index) => {
            const end = boundaries[index + 1]!;
            const spans = preview.highlights.filter((span) => span.start < end && span.end > start);
            return spans.length ? <mark key={start} title={[...new Set(spans.map((span) => label(span.kind)))].join("; ")} className="bg-hi text-hi-ink">{preview.text.slice(start, end)}</mark> : <span key={start}>{preview.text.slice(start, end)}</span>;
          })}
        </pre>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={busy || valuesChanged || !preview.text.trim()} onClick={() => onSend(preview.text)} data-testid="outbound-send">{t("send")}</Button>
        <Button variant="outline" disabled={busy} onClick={onCancel}>{t("cancel")}</Button>
      </div>
    </section>
  );
}
