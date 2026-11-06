"use client";

import { useId, useRef, useState } from "react";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { z } from "zod";
import type messages from "../../../messages/en.json";

import { getCareerExtractStatus, listCareerDrafts, type adoptCareerDraftAction } from "@/app/career/actions";
import { useControlRequest } from "@/components/control/use-control-request";
import { QueueHint } from "@/components/control/queue-hint";
import { nodeLabels } from "@/components/settings/field-control";
import { SendPreview } from "@/components/outbound/send-preview";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { AiProviderId } from "@/lib/ai/types";
import type { CareerConfig } from "@/lib/config/schemas/career";
import type { CareerDraft } from "@/lib/career/extract/draft-store";
import type { CareerProfile } from "@/lib/career/schema/profile";
import { STATUS_POLL_MS } from "@/lib/settings/constants";
import { outboundFailureSchema, preparedTextSchema, type PreparedText } from "@/lib/outbound/preview";
import { DraftReview } from "./draft-review";

const queuedSchema = z.object({ ok: z.literal(true), requestId: z.number().int().positive() });
type Status = Extract<Awaited<ReturnType<typeof getCareerExtractStatus>>, { ok: true }>["status"];
type Saved = Extract<Awaited<ReturnType<typeof adoptCareerDraftAction>>, { ok: true }>;
export type ExtractionView = { limits: CareerConfig["import"]; providers: AiProviderId[]; drafts: CareerDraft[]; open: Extract<Status, { state: "waiting" }> | null };

export function CareerExtraction({ view, profile, baseHash, dirty, onAdopted, onAdopting }: {
  view: ExtractionView; profile: CareerProfile; baseHash: string | null; dirty: boolean; onAdopted: (saved: Saved) => void; onAdopting?: (busy: boolean) => void;
}) {
  const t = useTranslations("career.extract");
  const ts = useTranslations("settings");
  const format = useFormatter();
  const now = useNow({ updateInterval: STATUS_POLL_MS });
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const source = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [origin, setOrigin] = useState<"resume" | "self_description">("resume");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [preview, setPreview] = useState<PreparedText | null>(null);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(view.open);
  const [drafts, setDrafts] = useState(view.drafts);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busy = sending || waiting !== null;
  function focusHeading() { requestAnimationFrame(() => heading.current?.focus()); }
  const wait = useControlRequest<null, number, string>({
    requestId: waiting?.requestId ?? null, initialStage: waiting?.stage, initialQueue: waiting?.queue,
    read: async (requestId) => {
      const result = await getCareerExtractStatus({ requestId });
      if (!result.ok) return { state: "failed", failed: result.code };
      const status = result.status;
      if (status.state === "waiting") return { state: "waiting", stage: status.stage, queue: status.queue, waiting: null };
      if (status.state === "done") return { state: "done", done: status.entries };
      if (status.state === "failed") return { state: "failed", failed: status.error };
      return { state: "missing" };
    },
    onDone: () => {
      setWaiting(null); setNotice("done"); focusHeading();
      void listCareerDrafts({}).then((result) => { if (result.ok) setDrafts(result.drafts); else setFailure(result.code); }).catch(() => setFailure("unavailable"));
    },
    onFailed: (error) => { setWaiting(null); setFailure(error ?? "unavailable"); focusHeading(); },
  });
  async function prepare(input?: { text: string; name: string; address: string; mode: "values" }): Promise<boolean> {
    setFailure(null); setNotice(null); setSending(true);
    try {
      let body: FormData | string;
      if (input) body = JSON.stringify(input);
      else if (file) {
        if (file.size > view.limits.max_file_bytes) { setFailure("too_large"); return false; }
        body = new FormData(); body.set("file", file);
      } else body = JSON.stringify({ text });
      const response = await fetch("/api/career/extract/prepare", { method: "POST", ...(typeof body === "string" ? { headers: { "Content-Type": "application/json" } } : {}), body });
      const raw: unknown = await response.json();
      const result = preparedTextSchema.safeParse(raw);
      if (result.success) {
        setPreview((old) => ({ ...result.data, removed: result.data.removed + (input ? old?.removed ?? 0 : 0), truncated: result.data.truncated || !!(input && old?.truncated) }));
        return true;
      }
      const error = outboundFailureSchema.safeParse(raw);
      setFailure(error.success ? error.data.error : "unavailable");
    } catch { setFailure("unavailable"); }
    finally { setSending(false); }
    return false;
  }
  async function send(confirmedText: string) {
    setSending(true); setFailure(null);
    try {
      const response = await fetch("/api/career/extract", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin, text: confirmedText }) });
      const raw: unknown = await response.json();
      const result = queuedSchema.safeParse(raw);
      if (result.success) {
        setWaiting({ state: "waiting", requestId: result.data.requestId, stage: "pending", queue: null });
        setPreview(null); setText(""); setFile(null); if (fileInput.current) fileInput.current.value = ""; focusHeading();
      } else {
        const error = outboundFailureSchema.safeParse(raw);
        setFailure(error.success ? error.data.error : "unavailable");
        if (error.success && error.data.error === "review_again" && error.data.text !== undefined) {
          setPreview((old) => old && ({ ...old, text: error.data.text!, chars: error.data.text!.length, highlights: [] }));
          setPreviewRevision((value) => value + 1);
        }
      }
    } catch { setFailure("unavailable"); }
    finally { setSending(false); }
  }
  const errorKey = `errors.${failure}` as `errors.${keyof typeof messages.career.extract.errors}`;
  const labels = nodeLabels(ts, view.providers);
  const providers = view.providers.map((provider) => labels[provider] ?? provider).join(" → ");
  return <Card data-testid="career-extraction" className="min-w-0">
    <CardHeader><CardTitle><h2 ref={heading} tabIndex={-1}>{t("title")}</h2></CardTitle></CardHeader>
    <CardContent className="flex min-w-0 flex-col gap-4">
      <p className="text-body-sm" data-testid="career-extract-disclosure">{providers ? t("disclosure", { providers }) : t("noProvider")}</p>
      <p className="text-body-sm">{t("residue")}</p>
      {preview ? <SendPreview key={previewRevision} preview={preview} busy={busy} onChange={setPreview} onPrepare={prepare} onSend={(value) => void send(value)} onCancel={() => { setPreview(null); requestAnimationFrame(() => source.current?.focus()); }} /> : <>
        <fieldset disabled={busy} className="flex flex-wrap gap-3"><legend className="text-label">{t("origin")}</legend>{(["resume", "self_description"] as const).map((value) => <label key={value} className="flex gap-2 text-body-sm"><input type="radio" name={`${id}-origin`} checked={origin === value} onChange={() => setOrigin(value)} />{t(value)}</label>)}</fieldset>
        <label htmlFor={`${id}-file`} className="text-label">{t("file")}</label>
        <input ref={fileInput} id={`${id}-file`} type="file" className="max-w-full text-body-sm" accept={view.limits.formats.map((value) => `.${value}`).join(",")} disabled={busy} onChange={(event) => { setFile(event.target.files?.[0] ?? null); setText(""); }} />
        <p className="text-body-sm">{t("fileHint", { formats: view.limits.formats.join(", "), max: format.number(view.limits.max_file_bytes) })}</p>
        <label htmlFor={`${id}-source`} className="text-label">{t("paste")}</label>
        <Textarea ref={source} id={`${id}-source`} rows={6} disabled={busy} value={text} onChange={(event) => { setText(event.target.value); setFile(null); if (fileInput.current) fileInput.current.value = ""; }} data-testid="career-extract-source" />
        <Button variant="primary" disabled={busy || (!file && !text.trim())} onClick={() => void prepare()}>{t("preview")}</Button>
      </>}
      {busy && <div role="status"><p>{t(wait.stage === "running" ? "running" : "waiting")}</p><QueueHint queue={wait.queue} stage={wait.stage} live={false} /></div>}
      {failure && <p role="alert" data-code={failure} className="text-bad break-words">{t.has(errorKey) ? t(errorKey) : t("errors.generic")}</p>}
      {notice && <p role="status">{t(notice as "done" | "adopted" | "discarded" | "draftRetained")}</p>}
      {drafts.length > 0 && <section className="flex min-w-0 flex-col gap-4" aria-label={t("pending", { count: drafts.length })}>
        <h3 className="text-title-sm font-bold">{t("pending", { count: drafts.length })}</h3>
        <p className="text-body-sm">{t("ttl", { days: view.limits.draft_ttl_days })}</p>
        {drafts.map((draft) => <details key={draft.request_id} className="min-w-0 rounded-card border-bw border-grid p-3" open>
          <summary className="cursor-pointer text-label">{t(draft.origin)} · {t("age", { date: format.dateTime(new Date(draft.created_at), { dateStyle: "medium", timeStyle: "short" }), age: format.relativeTime(new Date(draft.created_at), now) })}</summary>
          <DraftReview onAdopting={onAdopting} draft={draft} profile={profile} baseHash={baseHash} dirty={dirty} onAdopted={(saved) => { onAdopted(saved); setNotice(saved.draftDiscarded ? "adopted" : "draftRetained"); focusHeading(); }} onRemoved={(adopted) => { setNotice(adopted ? "adopted" : "discarded"); setDrafts((old) => old.filter((item) => item.request_id !== draft.request_id)); focusHeading(); }} />
        </details>)}
      </section>}
    </CardContent>
  </Card>;
}
