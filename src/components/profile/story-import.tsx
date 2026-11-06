"use client";

import { AlertTriangle, Check, FileUp, Loader2, Pencil, Sparkles, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useId, useRef, useState, useTransition } from "react";

import { adoptStoryDraftAction, discardStoryDraftAction, storyExtractStatusAction } from "@/app/me/actions";
import { SendPreview } from "@/components/outbound/send-preview";
import { preparedTextSchema, type PreparedText } from "@/lib/outbound/preview";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest, type ControlRequestStage } from "@/components/control/use-control-request";
import { nodeLabels } from "@/components/settings/field-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { INK_LINK } from "@/components/ui/ink-link";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { callAction } from "@/lib/actions/client";
import { controlQueueViewSchema, type ControlQueueView } from "@/lib/control/request-view-schema";
import type { StoryExtractErrorCode } from "@/lib/control/story-extract-request";
import { docsUrl } from "@/lib/docs-link";
import { formatClock } from "@/lib/format/clock";
import type { ProfileActionState } from "@/lib/profile/types";
import type { StoryImportView } from "@/lib/profile/view";
import { findPii } from "@/lib/stories/pii";
import { countFlags, draftFields, draftToStory, type AdoptedStory, type PendingStoryDraft, type StoredExtractField, type StoryExtractOrigin } from "@/lib/stories/extract";
import { storyExtractResponseSchema, type StoryExtractRouteError } from "@/lib/stories/extract-response";
import { toastTone } from "@/lib/toast";

import { Field, TagInput } from "./fields";

const ROUTE = "/api/me/story-extract";

type Failure = { error: StoryExtractRouteError | StoryExtractErrorCode; resumeAt: string | null };
type Entry = "self_description" | "resume";

interface StoryImportProps {
  view: StoryImportView;
  /** Hash of stories.yaml as this page loaded it: adopting is refused when the file changed since. */
  baseHash: string;
  /** The stories form has unsaved edits, which adopting (a save that reloads the form) would drop. */
  dirty: boolean;
}

/**
 * Below the experience library: get stories from your profile, a pasted text or an uploaded résumé (the disclosure next to
 * the buttons says where the text goes and what may remain of it), and review what comes back. stories.yaml changes only
 * when you adopt a draft.
 */
export function StoryImport({ view, baseHash, dirty }: StoryImportProps) {
  const t = useTranslations("profile.storyImport");
  const tSettings = useTranslations("settings");
  const locale = useLocale();
  const format = useFormatter();
  const router = useRouter();
  const pasteId = useId();
  const fileId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState<{ requestId: number; stage?: ControlRequestStage; queue?: ControlQueueView | null } | null>(view.open);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [preview, setPreview] = useState<PreparedText | null>(null);
  const [previewOrigin, setPreviewOrigin] = useState<StoryExtractOrigin>("resume");
  const [previewRevision, setPreviewRevision] = useState(0);

  const errorText = (next: Failure): string => t(`error.${next.error}`, { time: next.resumeAt ? formatClock(format, next.resumeAt) : "none", maxMb: (view.maxFileBytes / 1_000_000).toFixed(1), formats: view.formats.join(", ") });

  function fail(next: Failure) {
    setWaiting(null);
    setFailure(next);
    toastTone("error", errorText(next));
  }

  const wait = useControlRequest<null, number, Failure>({
    requestId: waiting?.requestId ?? null,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue ?? null,
    read: async (id) => {
      const result = await callAction(() => storyExtractStatusAction(id), () => null);
      if (result === null) return null;
      if (!result.ok) return result.error === "not_found" ? { state: "missing" } : { state: "failed", failed: { error: result.error, resumeAt: result.resumeAt } };
      if (result.state === "done") return { state: "done", done: result.drafts };
      const queue = controlQueueViewSchema.nullable().safeParse(result.queue);
      return queue.success ? { state: "waiting", stage: result.stage, queue: queue.data, waiting: null } : null;
    },
    onDone: (drafts) => {
      setWaiting(null);
      setEntry(null);
      setText("");
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
      toastTone(drafts > 0 ? "success" : "info", drafts > 0 ? t("doneToast", { count: drafts }) : t("noneFound"));
      router.refresh();
    },
    onFailed: (failed) => fail(failed ?? { error: "failed", resumeAt: null }),
  });

  const busy = sending || waiting !== null;

  async function prepare(origin: StoryExtractOrigin, input?: { text: string; name: string; address: string; mode: "values" }): Promise<boolean> {
    setFailure(null);
    let body: FormData | string;
    if (input) body = JSON.stringify(input);
    else if (origin === "profile") body = JSON.stringify({ origin });
    else if (origin === "self_description") body = JSON.stringify({ text });
    else {
      if (!file) return false;
      if (file.size > view.maxFileBytes) { fail({ error: "too_large", resumeAt: null }); return false; }
      body = new FormData();
      body.set("file", file);
    }
    setSending(true);
    try {
      const response = await fetch(`${ROUTE}/prepare`, { method: "POST", ...(typeof body === "string" ? { headers: { "Content-Type": "application/json" } } : {}), body });
      const raw: unknown = await response.json();
      const parsed = preparedTextSchema.safeParse(raw);
      if (parsed.success) {
        setPreview((old) => ({ ...parsed.data, removed: parsed.data.removed + (input ? old?.removed ?? 0 : 0), truncated: parsed.data.truncated || !!(input && old?.truncated) }));
        setPreviewOrigin(origin);
        if (!input) setPreviewRevision((value) => value + 1);
        return true;
      }
      const error = storyExtractResponseSchema.safeParse(raw);
      fail({ error: error.success && !error.data.ok ? error.data.error : "unavailable", resumeAt: null });
    } catch { fail({ error: "unavailable", resumeAt: null }); }
    finally { setSending(false); }
    return false;
  }

  async function send(confirmedText: string) {
    setFailure(null);
    setSending(true);
    try {
      const response = await fetch(ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ origin: previewOrigin, text: confirmedText }) });
      const parsed = storyExtractResponseSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) fail({ error: "unavailable", resumeAt: null });
      else if (parsed.data.ok) {
        setWaiting({ requestId: parsed.data.requestId });
        setPreview(null);
      } else {
        const result = parsed.data;
        if (result.error === "review_again" && result.text !== undefined) {
          setPreview((old) => old && ({ ...old, text: result.text!, chars: result.text!.length, highlights: result.highlights ?? [] }));
          setPreviewRevision((value) => value + 1);
        }
        fail({ error: result.error, resumeAt: null });
      }
    } catch { fail({ error: "unavailable", resumeAt: null }); }
    finally { setSending(false); }
  }

  const providers = view.providers.length > 0 ? ((labels) => view.providers.map((id) => labels[id] ?? id).join(" → "))(nodeLabels(tSettings, view.providers)) : t("noProvider");

  return (
    <Card className="gap-4 py-4" data-testid="story-import" data-state={busy ? "waiting" : failure ? "failed" : "ready"}>
      <CardHeader className="px-4 md:px-5">
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 px-4 md:px-5">
        {view.enabled ? (
          <>
            <div className="bg-soft rounded-card flex flex-col gap-1 px-3 py-2.5" data-testid="story-import-disclosure">
              <p className="text-body-sm" data-testid="story-import-providers">
                <span className="font-semibold">{t("sendsTo")}</span> {providers}
              </p>
              <p className="text-body-sm">
                {t("residue")}{" "}
                <a href={docsUrl(locale, "storyExtraction")} target="_blank" rel="noreferrer" className={INK_LINK}>
                  {t("residueLink")}
                </a>
              </p>
            </div>
            {preview ? <SendPreview key={previewRevision} preview={preview} busy={busy} onChange={setPreview} onPrepare={(input) => prepare(previewOrigin, input)} onSend={(value) => void send(value)} onCancel={() => setPreview(null)} /> : <>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void prepare("profile")} data-testid="story-import-profile">
                <Sparkles aria-hidden />
                {t("fromProfile")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} aria-expanded={entry === "self_description"} onClick={() => setEntry(entry === "self_description" ? null : "self_description")} data-testid="story-import-paste">
                <Pencil aria-hidden />
                {t("paste")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} aria-expanded={entry === "resume"} onClick={() => setEntry(entry === "resume" ? null : "resume")} data-testid="story-import-upload">
                <FileUp aria-hidden />
                {t("upload")}
              </Button>
            </div>
            {entry === "self_description" ? (
              <div className="flex flex-col items-start gap-2">
                <Field id={pasteId} label={t("pasteLabel")} hint={t("pasteHint", { max: format.number(view.maxChars) })} error={undefined}>
                  <Textarea id={pasteId} rows={6} value={text} onChange={(event) => setText(event.target.value)} disabled={busy} autoComplete="off" data-testid="story-import-text" />
                </Field>
                <Button type="button" variant="primary" size="sm" disabled={busy || text.trim() === ""} onClick={() => void prepare("self_description")} data-testid="story-import-send-text">
                  {t("preview")}
                </Button>
              </div>
            ) : null}
            {entry === "resume" ? (
              <div className="flex flex-col items-start gap-2">
                <label htmlFor={fileId} className="text-body-sm font-semibold">
                  {t("fileLabel")}
                </label>
                <input
                  ref={fileInput}
                  id={fileId}
                  type="file"
                  accept={view.formats.map((type) => `.${type}`).join(",")}
                  disabled={busy}
                  className="text-body-sm max-w-full"
                  aria-describedby={`${fileId}-hint`}
                  onChange={(event) => setFile(event.target.files?.[0] ?? null)}
                  data-testid="story-import-file"
                />
                <p id={`${fileId}-hint`} className="text-ink-3 text-body-sm">
                  {t("fileHint", { formats: view.formats.join(", "), maxMb: (view.maxFileBytes / 1_000_000).toFixed(1) })}
                </p>
                <Button type="button" variant="primary" size="sm" disabled={busy || file === null} onClick={() => void prepare("resume")} data-testid="story-import-send-file">
                  {t("preview")}
                </Button>
              </div>
            ) : null}
            </>}
            {busy ? (
              <div className="flex flex-col gap-1" role="status" data-testid="story-import-waiting">
                <p className="text-body-sm flex items-center gap-2">
                  <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
                  {wait.stage === "running" ? t("running") : t("requesting")}
                </p>
                <QueueHint queue={wait.queue} stage={wait.stage} live={false} />
              </div>
            ) : null}
            {failure && !busy ? (
              <p role="alert" className="text-bad text-body-sm font-semibold [overflow-wrap:anywhere]" data-testid="story-import-error" data-error={failure.error}>
                {errorText(failure)}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-body-sm" data-testid="story-import-off">
            {t("off")}{" "}
            <Link href="/settings?tab=workflow" className={INK_LINK}>
              {t("offLink")}
            </Link>
          </p>
        )}
        {view.drafts.length > 0 ? (
          <section className="flex flex-col gap-3" aria-labelledby={`${fileId}-pending`} data-testid="story-drafts">
            <div className="flex flex-col gap-1">
              <h3 id={`${fileId}-pending`} className="text-title-sm font-bold">
                {t("pendingTitle", { count: view.drafts.length })}
              </h3>
              <p className="text-ink-2 text-body-sm">{t("pendingHint", { days: view.ttlDays })}</p>
              {dirty ? <p className="text-warning-text text-body-sm" role="status" data-testid="story-drafts-dirty">{t("saveFirst")}</p> : null}
            </div>
            <ul className="flex flex-col gap-3">
              {view.drafts.map((draft) => (
                <DraftRow key={draft.id} draft={draft} baseHash={baseHash} dirty={dirty} />
              ))}
            </ul>
          </section>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FlaggedValue({ field, label }: { field: StoredExtractField; label: string }) {
  const t = useTranslations("profile.storyImport");
  return (
    <div className="flex flex-col gap-0.5" data-testid="story-draft-field" data-flag={field.flag ?? "ok"}>
      <dt className="text-ink-3 text-body-sm">{label}</dt>
      <dd className="text-body-sm [overflow-wrap:anywhere]">
        <span className={field.flag ? "bg-[color-mix(in_srgb,var(--warn)_28%,transparent)] rounded-tag px-1" : undefined}>{field.value}</span>
        {field.flag ? (
          <span className="text-warning-text ml-1 inline-flex items-center gap-1 align-middle font-semibold">
            <AlertTriangle aria-hidden className="size-3.5 shrink-0" />
            {t(`flag.${field.flag}`, { missing: field.missing.join(", ") })}
          </span>
        ) : null}
        {field.quote !== "" ? <span className="text-ink-3 mt-0.5 block text-data">{t("quote", { quote: field.quote })}</span> : null}
      </dd>
    </div>
  );
}

function DraftRow({ draft, baseHash, dirty }: { draft: PendingStoryDraft; baseHash: string; dirty: boolean }) {
  const t = useTranslations("profile.storyImport");
  const tStories = useTranslations("profile.stories");
  const tErrors = useTranslations("profile.errors");
  const router = useRouter();
  const base = useId();
  const [editing, setEditing] = useState(false);
  const [edited, setEdited] = useState<AdoptedStory>(() => {
    const { title, what, result, period, metrics, skills, language } = draftToStory(draft.draft, draft.origin);
    return { title, what, result, period, metrics, skills, language };
  });
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const fields = draft.draft;
  const flags = countFlags(fields);
  const pii = [...new Set(draftFields(fields).flatMap((field) => findPii(`${field.value}\n${field.quote}`)))];

  function explain(result: ProfileActionState): string {
    if (result.status !== "error") return t("adoptFailed");
    if (result.formError === "stale") return t("stale");
    const first = result.fieldErrors[0];
    return first ? t("adoptRefused", { detail: tErrors(first.key, first.params) }) : t("adoptFailed");
  }

  function adopt() {
    setProblem(null);
    startTransition(async () => {
      const result = await callAction(() => adoptStoryDraftAction({ draftId: draft.id, baseHash, ...(editing ? { edited } : {}) }), () => ({ status: "failed" as const }));
      if (result.status === "saved") {
        toastTone("success", t("adopted", { title: editing ? edited.title : fields.title.value }));
        router.refresh();
      } else if (result.status === "refused") {
        setProblem(explain(result.result));
        setEditing(true);
      } else {
        setProblem(t(result.status === "not_found" ? "gone" : result.status === "unreadable" ? "unreadable" : "adoptFailed"));
        if (result.status === "not_found") router.refresh();
      }
    });
  }

  function discard() {
    setProblem(null);
    startTransition(async () => {
      const result = await callAction(() => discardStoryDraftAction(draft.id), () => ({ ok: false }));
      if (result.ok) router.refresh();
      else setProblem(t("adoptFailed"));
    });
  }

  return (
    <li className="border-border bg-card flex flex-col gap-3 rounded-card border-bw px-3 py-3" data-testid="story-draft" data-flags={flags}>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="status">{tStories(`source.${draft.origin}`)}</Badge>
        {flags > 0 ? (
          <Badge variant="status-warn" data-testid="story-draft-flagged">
            <AlertTriangle aria-hidden className="size-3" />
            {t("flagged", { count: flags })}
          </Badge>
        ) : null}
        {pii.length > 0 ? (
          <Badge variant="status-warn" data-testid="story-draft-pii">
            <AlertTriangle aria-hidden className="size-3" />
            {tStories("piiBadge")}
          </Badge>
        ) : null}
      </div>
      {pii.length > 0 ? (
        <p role="status" className="border-warn flex items-start gap-2 rounded-tag border-bw px-3 py-2 text-body-sm">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>{tStories("piiWarning", { kinds: pii.map((kind) => tStories(`pii.${kind}`)).join(", ") })}</span>
        </p>
      ) : null}
      {editing ? (
        <div className="flex flex-col gap-4" data-testid="story-draft-form">
          <Field id={`${base}-title`} label={tStories("fields.title")} error={undefined}>
            <Input id={`${base}-title`} value={edited.title} onChange={(event) => setEdited({ ...edited, title: event.target.value })} autoComplete="off" data-testid="story-draft-title" />
          </Field>
          <Field id={`${base}-what`} label={tStories("fields.what")} error={undefined}>
            <Textarea id={`${base}-what`} rows={3} value={edited.what} onChange={(event) => setEdited({ ...edited, what: event.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${base}-result`} label={tStories("fields.result")} error={undefined}>
            <Textarea id={`${base}-result`} rows={2} value={edited.result} onChange={(event) => setEdited({ ...edited, result: event.target.value })} autoComplete="off" />
          </Field>
          <Field id={`${base}-metrics`} label={tStories("fields.metrics")} hint={tStories("hints.metrics")} error={undefined}>
            <TagInput id={`${base}-metrics`} values={edited.metrics} onChange={(metrics) => setEdited({ ...edited, metrics })} invalid={false} describedBy={undefined} dedupe="exact" commitOnComma={false} />
          </Field>
          <Field id={`${base}-skills`} label={tStories("fields.skills")} hint={tStories("hints.list")} error={undefined}>
            <TagInput id={`${base}-skills`} values={edited.skills} onChange={(skills) => setEdited({ ...edited, skills })} invalid={false} describedBy={undefined} />
          </Field>
          <Field id={`${base}-period`} label={tStories("fields.period")} error={undefined}>
            <Input id={`${base}-period`} value={edited.period} onChange={(event) => setEdited({ ...edited, period: event.target.value })} autoComplete="off" />
          </Field>
        </div>
      ) : (
        <dl className="flex flex-col gap-2">
          <FlaggedValue field={fields.title} label={tStories("fields.title")} />
          <FlaggedValue field={fields.what} label={tStories("fields.what")} />
          {fields.result ? <FlaggedValue field={fields.result} label={tStories("fields.result")} /> : null}
          {fields.period ? <FlaggedValue field={fields.period} label={tStories("fields.period")} /> : null}
          {fields.metrics.map((field) => <FlaggedValue key={`m-${field.value}`} field={field} label={tStories("fields.metrics")} />)}
          {fields.skills.map((field) => <FlaggedValue key={`s-${field.value}`} field={field} label={tStories("fields.skills")} />)}
        </dl>
      )}
      {problem ? <p role="alert" className="text-bad text-body-sm [overflow-wrap:anywhere]" data-testid="story-draft-error">{problem}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="primary" size="sm" disabled={pending || dirty} onClick={adopt} data-testid="story-draft-adopt">
          {pending ? <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden /> : <Check aria-hidden />}
          {editing ? t("adoptEdited") : t("adopt")}
        </Button>
        <Button type="button" variant="outline" size="sm" disabled={pending} aria-expanded={editing} onClick={() => setEditing(!editing)} data-testid="story-draft-edit">
          {editing ? <X aria-hidden /> : <Pencil aria-hidden />}
          {editing ? t("cancelEdit") : t("edit")}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={discard} data-testid="story-draft-discard">
          <Trash2 aria-hidden />
          {t("discard")}
        </Button>
      </div>
    </li>
  );
}
