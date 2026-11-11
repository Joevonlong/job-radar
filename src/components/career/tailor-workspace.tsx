"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";
import type messages from "../../../messages/en.json";
import { QueueHint } from "@/components/control/queue-hint";
import { useControlRequest } from "@/components/control/use-control-request";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ProposalReview } from "./proposal-review";
import { callTailor, preparedSchema, queuedSchema, tailorStatusSchema, type OutboundPreview, type TailorStatus } from "./tailor-api";
import { TailorPreview } from "./tailor-preview";

type Job = { id: number; title: string; company: string };
export type TailorView = {
  limits: { maxRequirements: number; requirementMaxChars: number };
  preferences: { emphasis: string | null; tone: string | null } | null;
  job: Job | null;
  jobState: "job_gone" | "no_jd" | null;
  doc: { id: string; title: string; jobId: number | null; requirements: string[] } | null;
  mode: "tailor" | "shrink";
  overPages: number | null;
  status: TailorStatus | null;
  hasProposals: boolean;
};

const searchSchema = z.object({ jobs: z.array(z.object({ id: z.number().int().positive(), title: z.string(), company: z.string() })) });
type ErrorKey = `errors.${keyof typeof messages.career.tailor.errors}`;

/** Pick a job, write this application's requirements, review exactly what will be sent, then queue the request and review its suggestions. */
export function TailorWorkspace({ view }: { view: TailorView }) {
  const t = useTranslations("career.tailor");
  const router = useRouter();
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const [job, setJob] = useState<Job | null>(view.job);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Job[] | null>(null);
  const [docId, setDocId] = useState(view.doc?.id ?? null);
  const [requirements, setRequirements] = useState(view.doc?.requirements ?? []);
  const [withLetter, setWithLetter] = useState(false);
  const [existing, setExisting] = useState<string | null>(null);
  const [preview, setPreview] = useState<OutboundPreview | null>(null);
  const [replaces, setReplaces] = useState(view.hasProposals);
  const [sending, setSending] = useState(false);
  const [waiting, setWaiting] = useState(view.status?.state === "waiting" ? view.status : null);
  const [failure, setFailure] = useState<string | null>(view.jobState ?? (view.status?.state === "failed" ? view.status.error : null));
  const [done, setDone] = useState<Extract<TailorStatus, { state: "done" }> | null>(null);
  const [reviewKey, setReviewKey] = useState(0);
  const shrink = view.mode === "shrink";
  const busy = sending || waiting !== null;
  const tooMany = requirements.length > view.limits.maxRequirements;
  const tooLong = requirements.some((text) => text.length > view.limits.requirementMaxChars);
  const ready = !busy && !tooMany && !tooLong && (shrink ? docId !== null : job !== null);
  const focusHeading = () => requestAnimationFrame(() => heading.current?.focus());
  const wait = useControlRequest<null, Extract<TailorStatus, { state: "done" }>, string>({
    requestId: waiting?.requestId ?? null,
    initialStage: waiting?.stage,
    initialQueue: waiting?.queue,
    read: async () => {
      if (!docId) return { state: "missing" };
      const status = await callTailor(tailorStatusSchema, `/api/career/tailor/status?doc_id=${encodeURIComponent(docId)}`);
      if ("ok" in status) return null;
      if (status.state === "waiting") return { state: "waiting", stage: status.stage, queue: status.queue, waiting: null };
      if (status.state === "done") return { state: "done", done: status };
      if (status.state === "failed") return { state: "failed", failed: status.error };
      return { state: "missing" };
    },
    onDone: (result) => { setWaiting(null); setDone(result); setReplaces(result.proposals > 0); setReviewKey((key) => key + 1); focusHeading(); },
    onFailed: (error) => { setWaiting(null); setFailure(error ?? "unavailable"); focusHeading(); },
  });
  async function search() {
    setFailure(null);
    const result = await callTailor(searchSchema, `/api/search?q=${encodeURIComponent(query)}`);
    setResults("jobs" in result ? result.jobs : []);
    if (!("jobs" in result)) setFailure(result.error);
  }
  function choose(next: Job) {
    setJob(next); setResults(null); setExisting(null); setPreview(null); setFailure(null);
    if (docId) { setDocId(null); window.history.replaceState(null, "", `/career/tailor?job=${next.id}`); }
  }
  async function prepare(createNew = false) {
    setFailure(null); setDone(null); setSending(true);
    try {
      const body = docId ? { doc_id: docId, mode: view.mode, ...(shrink ? {} : { requirements }) }
        : { jobId: job?.id, mode: "tailor", requirements, ...(createNew ? { new: true } : {}) };
      const result = await callTailor(preparedSchema, "/api/career/tailor/prepare", body);
      if (!result.ok) { setFailure(result.error); return; }
      if (result.existing) { setExisting(result.doc_id); return; }
      setExisting(null);
      if (result.doc_id !== docId) window.history.replaceState(null, "", `/career/tailor?doc=${result.doc_id}`);
      setDocId(result.doc_id);
      setReplaces(result.hasProposals);
      setPreview({ blocks: result.blocks, jd: result.jd, jd_truncated: result.jd_truncated, hash: result.hash });
      focusHeading();
    } finally { setSending(false); }
  }
  async function send() {
    if (!preview || !docId) return;
    setSending(true); setFailure(null);
    try {
      const result = await callTailor(queuedSchema, "/api/career/tailor", {
        mode: view.mode, doc_id: docId, jobId: view.doc ? view.doc.jobId : job?.id ?? null,
        with_letter: !shrink && withLetter, over_pages: shrink ? view.overPages : null, outbound_hash: preview.hash,
      });
      if (result.ok) {
        setWaiting({ state: "waiting", requestId: result.requestId, stage: "pending", queue: null });
        setPreview(null); focusHeading();
        return;
      }
      setFailure(result.error);
      if ("blocks" in result) setPreview({ blocks: result.blocks, jd: result.jd, jd_truncated: result.jd_truncated, hash: result.hash });
    } finally { setSending(false); }
  }
  const errorKey = `errors.${failure}` as ErrorKey;
  const defaultsLink = docId ? `/career/documents/${docId}` : "/career/documents";
  return (
    <Card data-testid="career-tailor" className="min-w-0">
      <CardHeader>
        <CardTitle><h2 ref={heading} tabIndex={-1}>{t(shrink ? "shrinkTitle" : "formTitle")}</h2></CardTitle>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <p className="text-body-sm">{t("difference")}</p>
        {shrink ? (
          <p data-testid="tailor-shrink-note">{t("shrinkNote", { title: view.doc?.title ?? "", over: view.overPages ?? 0 })}</p>
        ) : view.doc?.jobId != null ? (
          <p data-testid="tailor-job">{t("jobChosen", { title: job?.title ?? view.doc?.title ?? "", company: job?.company ?? "" })}</p>
        ) : (
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2">
            <legend className="text-label">{t("job")}</legend>
            {job && <p data-testid="tailor-job">{t("jobChosen", { title: job.title, company: job.company })}</p>}
            <form className="flex min-w-0 flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void search(); }}>
              <label htmlFor={`${id}-search`} className="sr-only">{t("search")}</label>
              <Input id={`${id}-search`} className="min-w-0 flex-1" placeholder={t("searchPlaceholder")} value={query} onChange={(event) => setQuery(event.target.value)} />
              <Button type="submit" variant="outline">{t("search")}</Button>
            </form>
            {results && (results.length ? (
              <ul className="flex min-w-0 flex-col gap-1" aria-label={t("results")}>
                {results.map((item) => (
                  <li key={item.id} className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="min-w-0 break-words">{item.title} · {item.company}</span>
                    <Button size="sm" variant="ghost" onClick={() => choose(item)} aria-label={t("chooseJob", { title: item.title, company: item.company })}>{t("choose")}</Button>
                  </li>
                ))}
              </ul>
            ) : <p>{t("noResults")}</p>)}
          </fieldset>
        )}
        {!shrink && (
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2" data-testid="tailor-requirements">
            <legend className="text-label">{t("requirements")}</legend>
            <p className="text-body-sm">{t("requirementsHint", { max: view.limits.maxRequirements, chars: view.limits.requirementMaxChars })}</p>
            {requirements.map((text, index) => (
              <div key={index} className="flex min-w-0 flex-col gap-1">
                <label htmlFor={`${id}-req-${index}`} className="text-label">{t("requirement", { number: index + 1 })}</label>
                <Textarea id={`${id}-req-${index}`} rows={2} value={text} aria-invalid={text.length > view.limits.requirementMaxChars} onChange={(event) => setRequirements(requirements.map((old, at) => at === index ? event.target.value : old))} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-data text-ink-2">{t("chars", { count: text.length, max: view.limits.requirementMaxChars })}</span>
                  <Button size="sm" variant="ghost" onClick={() => setRequirements(requirements.filter((_, at) => at !== index))}>{t("removeRequirement", { number: index + 1 })}</Button>
                </div>
              </div>
            ))}
            <Button variant="outline" className="w-fit" disabled={requirements.length >= view.limits.maxRequirements} onClick={() => setRequirements([...requirements, ""])}>{t("addRequirement")}</Button>
            {tooMany && <p role="alert">{t("tooMany", { max: view.limits.maxRequirements })}</p>}
            {tooLong && <p role="alert">{t("tooLong", { chars: view.limits.requirementMaxChars })}</p>}
            <label className="flex items-center gap-2 text-label">
              <Checkbox checked={withLetter} onCheckedChange={(value) => setWithLetter(value === true)} />
              {t("withLetter")}
            </label>
          </fieldset>
        )}
        <div className="flex min-w-0 flex-col gap-1 text-body-sm" data-testid="tailor-defaults">
          <p className="text-label">{t("defaults")}</p>
          <p className="break-words">{t("emphasis", { value: view.preferences?.emphasis || t("unset") })}</p>
          <p className="break-words">{t("tone", { value: view.preferences?.tone || t("unset") })}</p>
          <Link href={defaultsLink} className="w-fit underline">{t("editDefaults")}</Link>
        </div>
        {existing && (
          <div role="alert" className="flex min-w-0 flex-col gap-2" data-testid="tailor-existing">
            <p>{t("existing")}</p>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" onClick={() => router.push(`/career/tailor?doc=${existing}`)}>{t("openExisting")}</Button>
              <Button variant="outline" disabled={busy} onClick={() => void prepare(true)}>{t("createNew")}</Button>
            </div>
          </div>
        )}
        {preview ? (
          <TailorPreview preview={preview} replaces={replaces} busy={busy} onConfirm={() => void send()} onCancel={() => setPreview(null)} />
        ) : (
          <Button variant="primary" className="w-fit" disabled={!ready} onClick={() => void prepare()}>{t("preview")}</Button>
        )}
        {busy && waiting && (
          <div role="status" data-testid="tailor-waiting">
            <p>{t(wait.stage === "running" ? "running" : "waiting")}</p>
            <QueueHint queue={wait.queue} stage={wait.stage} live={false} />
          </div>
        )}
        {failure && (
          <p role="alert" data-code={failure} className="break-words text-bad">
            {t.has(errorKey) ? t(errorKey) : t("errors.generic")} <span className="font-mono text-data">({failure})</span>
          </p>
        )}
        {done && <p role="status" data-testid="tailor-done">{t("done", { proposals: done.proposals, dropped: done.dropped, flagged: done.flagged })}</p>}
        {docId && (
          <div className="flex flex-wrap gap-3">
            <Link href={`/career/documents/${docId}`} className="underline">{t("openDocument")}</Link>
          </div>
        )}
        {docId && !waiting && <ProposalReview key={`${docId}-${reviewKey}`} docId={docId} />}
      </CardContent>
    </Card>
  );
}
