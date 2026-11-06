"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { INK_LINK } from "@/components/ui/ink-link";
import { applyConfirmResultSchema, applyPreviewSchema } from "@/lib/career/apply/schema";
import type { ApplyConfirmResult, ApplyPreview, ApplySelection } from "@/lib/career/apply/service";
import type { MeFieldChange } from "@/lib/career/apply/project-me";
import type { StoryChange } from "@/lib/career/apply/project-stories";

const ROUTE = "/api/career/apply";
const responseSchema = z.union([
  z.object({ ok: z.literal(true), preview: applyPreviewSchema }),
  z.object({ ok: z.literal(true), result: applyConfirmResultSchema }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
type ApplyResponse =
  | { ok: true; preview: ApplyPreview }
  | { ok: true; result: ApplyConfirmResult }
  | { ok: false; error: string };

const ERRORS = ["me_required", "profile_empty", "too_many", "disabled", "contact_invalid", "contact_unreadable", "profile_invalid", "config_error", "invalid", "unavailable"] as const;
type ApplyError = (typeof ERRORS)[number];
const knownError = (code: string): ApplyError => ERRORS.find((known) => known === code) ?? "unavailable";

async function post(body: unknown): Promise<ApplyResponse> {
  try {
    const response = await fetch(ROUTE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const parsed = responseSchema.safeParse(await response.json());
    return parsed.success ? (parsed.data as ApplyResponse) : { ok: false, error: "unavailable" };
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

function meValue(change: MeFieldChange, value: MeFieldChange["current"]): string {
  if (value === null || value === "") return "—";
  if (change.field === "languages") return (value as Record<string, string>[]).map((entry) => Object.entries(entry).map(([code, level]) => `${code} ${level}`).join("")).join(", ") || "—";
  if (change.field === "skills") return (value as { name: string; years: number | null }[]).map((skill) => (skill.years === null ? skill.name : `${skill.name} (${skill.years})`)).join(", ") || "—";
  return String(value);
}

/** The "apply to matching" step of the career page: preview, choose, confirm. */
export function ApplyPanel({ changedSinceApply }: { changedSinceApply: boolean }) {
  const t = useTranslations("career.apply");
  const router = useRouter();
  const [preview, setPreview] = useState<ApplyPreview | null>(null);
  const [result, setResult] = useState<Extract<ApplyConfirmResult, { status: "applied" }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(selection: ApplySelection | null) {
    setBusy(true);
    setError(null);
    const response = await post({ action: "preview", selection });
    setBusy(false);
    if ("preview" in response) setPreview(response.preview);
    else if (!response.ok) setError(response.error);
  }

  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    const response = await post({ action: "confirm", selection: preview.selection, bases: preview.bases });
    setBusy(false);
    if (!response.ok) return setError(response.error);
    if (!("result" in response)) return setError("unavailable");
    if (response.result.status === "stale") {
      setPreview(response.result.preview);
      setNotice(t("stale"));
      return;
    }
    if (response.result.status === "applied") {
      setResult(response.result);
      setPreview(null);
      router.refresh();
    }
  }

  function toggleMe(field: MeFieldChange["field"], checked: boolean) {
    if (!preview) return;
    void load({ ...preview.selection, me: { ...preview.selection.me, [field]: checked } });
  }

  function toggleStory(change: StoryChange, checked: boolean) {
    if (!preview) return;
    const key = change.kind === "removed" ? "remove" : "write";
    const ids = new Set(preview.selection.stories[key]);
    if (checked) ids.add(change.id);
    else ids.delete(change.id);
    void load({ ...preview.selection, stories: { ...preview.selection.stories, [key]: [...ids] } });
  }

  const meChanges = preview?.me.fields.filter((change) => change.changed) ?? [];
  const storyChanges = preview?.stories.changes.filter((change) => change.kind !== "unchanged") ?? [];

  return (
    <section className="rounded-card border-bw border-grid flex flex-col gap-3 p-4" data-testid="career-apply">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-title-sm font-bold">{t("title")}</h2>
        {preview === null ? (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void load(null)} data-testid="career-apply-preview">
            {t("preview")}
          </Button>
        ) : null}
      </div>
      <p className="text-body-sm">{t("description")}</p>
      {changedSinceApply ? <p className="text-body-sm font-semibold" data-testid="career-apply-changed">{t("changedSince")}</p> : null}
      {error ? (
        <p role="alert" className="text-bad text-body-sm" data-testid="career-apply-error" data-error={error}>
          {t(`errors.${knownError(error)}`)}{" "}
          {error === "me_required" ? <Link href="/me" className={INK_LINK}>{t("openMe")}</Link> : null}
        </p>
      ) : null}
      {notice ? <p role="status" className="text-body-sm" data-testid="career-apply-notice">{notice}</p> : null}
      {result ? (
        <div role="status" className="flex flex-col gap-1" data-testid="career-apply-result" data-me={result.me} data-stories={result.stories}>
          <p className="text-body-sm">{t("result.me", { state: result.me })}</p>
          <p className="text-body-sm">{t("result.stories", { state: result.stories })}</p>
          <p className="text-body-sm" data-testid="career-apply-stale-marked">
            {result.staleMarked === null ? t("result.staleUnknown") : t("result.staleMarked", { count: result.staleMarked })}
            {result.staleMarked !== null && result.staleMarked !== result.staleExpected ? ` ${t("result.staleDiffers", { expected: result.staleExpected })}` : null}
          </p>
        </div>
      ) : null}
      {preview ? (
        <div className="flex flex-col gap-4" data-testid="career-apply-review" aria-busy={busy}>
          {preview.noChanges && meChanges.length === 0 && storyChanges.length === 0 ? <p className="text-body-sm" data-testid="career-apply-nothing">{t("nothing")}</p> : null}
          {meChanges.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-body font-semibold">{t("meTitle")}</h3>
              {meChanges.map((change) => (
                <label key={change.field} className="flex items-start gap-2" data-testid={`career-apply-me-${change.field}`}>
                  <Checkbox checked={preview.selection.me[change.field]} disabled={busy} onCheckedChange={(checked) => toggleMe(change.field, checked === true)} />
                  <span className="text-body-sm flex min-w-0 flex-col [overflow-wrap:anywhere]">
                    <span className="font-semibold">{t(`fields.${change.field}`)}{change.truncated ? <Badge variant="status" className="ml-2">{t("truncated")}</Badge> : null}</span>
                    <span className="text-ink-3">{t("from", { value: meValue(change, change.current) })}</span>
                    <span>{t("to", { value: meValue(change, change.proposed) })}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {preview.me.languagesNotApplied.length > 0 ? <p className="text-ink-3 text-body-sm">{t("languagesNotApplied", { names: preview.me.languagesNotApplied.join(", ") })}</p> : null}
          {storyChanges.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-body font-semibold">{t("storiesTitle")}</h3>
              {storyChanges.map((change) => (
                <label key={change.id} className="flex items-start gap-2" data-testid="career-apply-story" data-kind={change.kind}>
                  <Checkbox
                    checked={(change.kind === "removed" ? preview.selection.stories.remove : preview.selection.stories.write).includes(change.id)}
                    disabled={busy}
                    onCheckedChange={(checked) => toggleStory(change, checked === true)}
                  />
                  <span className="text-body-sm flex min-w-0 flex-col gap-1 [overflow-wrap:anywhere]">
                    <span className="font-semibold">
                      {t(`kind.${change.kind === "unchanged" ? "changed" : change.kind}`)}: {(change.proposed ?? change.current)?.title}
                      {change.truncated ? <Badge variant="status" className="ml-2">{t("truncated")}</Badge> : null}
                    </span>
                    {change.kind === "changed" && change.current ? <span className="text-ink-3 whitespace-pre-line">{t("from", { value: change.current.what })}</span> : null}
                    {change.proposed ? <span className="whitespace-pre-line">{change.kind === "changed" ? t("to", { value: change.proposed.what }) : change.proposed.what}</span> : null}
                  </span>
                </label>
              ))}
            </div>
          ) : null}
          {preview.stories.notApplied.length > 0 ? <p className="text-ink-3 text-body-sm">{t("storiesNotApplied", { names: preview.stories.notApplied.join(", ") })}</p> : null}
          {preview.tooMany ? <p role="alert" className="text-bad text-body-sm">{t("errors.too_many", { max: preview.maxItems })}</p> : null}
          <p className="text-body-sm font-semibold" data-testid="career-apply-stale-count">{t("staleCount", { count: preview.staleCount })}</p>
          <p className="bg-soft rounded-card text-body-sm px-3 py-2.5" data-testid="career-apply-retention">{t("retention")}</p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" size="sm" disabled={busy || preview.noChanges || preview.tooMany} onClick={() => void confirm()} data-testid="career-apply-confirm">
              {t("confirm")}
            </Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setPreview(null)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
