"use client";

import { useId, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { adoptCareerDraftAction, discardCareerDraftAction } from "@/app/career/actions";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { AdoptDecisions } from "@/lib/career/extract/adopt";
import type { CareerDraft } from "@/lib/career/extract/draft-store";
import { DRAFT_SECTIONS, type DraftEntry, type VerifiedField } from "@/lib/career/extract/verify";
import { primaryText, type CareerProfile } from "@/lib/career/schema/profile";
import { careerErrorMessageKey } from "./error-messages";

type Decision = AdoptDecisions[number];
type Saved = Extract<Awaited<ReturnType<typeof adoptCareerDraftAction>>, { ok: true }>;

function EvidenceField({ field, label, value, onChange, disabled }: { field: VerifiedField; label: string; value: string; onChange: (value: string) => void; disabled: boolean }) {
  const t = useTranslations("career.extract");
  return <div className="flex min-w-0 flex-col gap-1" data-testid="career-draft-field">
    <label className="text-label">{label}<Textarea value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} /></label>
    <blockquote className="text-ink-3 whitespace-pre-wrap break-words text-data">{t("quote", { quote: field.quote })}</blockquote>
    {field.flags.map((flag) => <p key={flag} data-code={flag} className="text-warning-text text-body-sm">{t(`flags.${flag}`)}</p>)}
  </div>;
}

function EntryReview({ entry, section, decision, update, disabled, profile, decisions }: {
  entry: DraftEntry; section: typeof DRAFT_SECTIONS[number]; decision: Decision;
  update: (decision: Decision) => void; disabled: boolean; profile: CareerProfile; decisions: AdoptDecisions;
}) {
  const t = useTranslations("career.extract");
  const tc = useTranslations("career");
  const id = useId();
  const match = profile[section].find((item) => item.id === entry.match);
  const matchLabel = match && ("company" in match ? `${match.company} · ${primaryText(match.role)}` : "school" in match ? `${match.school} · ${primaryText(match.degree)}` : "group" in match ? match.group : "title" in match ? primaryText(match.title) : match.name);
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3 rounded-card border-bw border-grid p-3" data-testid="career-draft-entry">
    <legend className="text-label">{Object.values(entry.fields).find((field) => field?.value)?.value || tc(`sections.${section}`)}</legend>
    {matchLabel && <p className="text-body-sm">{t("match", { entry: matchLabel })}</p>}
    <label className="text-label" htmlFor={`${id}-decision`}>{t("decision")}</label>
    <select id={`${id}-decision`} className="max-w-full rounded-card border-bw border-grid p-2" value={decision.action} onChange={(event) => update({ ...decision, action: event.target.value as Decision["action"] })}>
      <option value="skip">{t("skip")}</option><option value="new">{t("new")}</option>{entry.match && <option value="merge">{t("merge")}</option>}
    </select>
    {decision.action === "merge" && <p className="text-body-sm">{t("mergeHint")}</p>}
    {Object.entries(entry.fields).map(([key, field]) => field && <EvidenceField key={key} field={field} label={tc(`fields.${key as keyof typeof entry.fields}`)} value={decision.fields?.[key as keyof typeof entry.fields] ?? field.value} onChange={(value) => update({ ...decision, fields: { ...decision.fields, [key]: value } })} disabled={disabled} />)}
    {entry.bullets.map((field, index) => <div key={index} className="flex min-w-0 flex-col gap-1">
      <label className="flex items-center gap-2 text-body-sm"><input type="checkbox" checked={decision.bullets?.includes(field.value) ?? true} onChange={(event) => {
        const kept = new Set(decision.bullets ?? entry.bullets.map((item) => item.value));
        if (event.target.checked) kept.add(field.value); else kept.delete(field.value);
        update({ ...decision, bullets: entry.bullets.map((item) => item.value).filter((value) => kept.has(value)) });
      }} />{t("includeBullet", { number: index + 1 })}</label>
      <p className="whitespace-pre-wrap break-words text-body-sm">{field.value}</p>
      <blockquote className="text-ink-3 break-words text-data">{t("quote", { quote: field.quote })}</blockquote>
      {field.flags.map((flag) => <p key={flag} data-code={flag} className="text-warning-text text-body-sm">{t(`flags.${flag}`)}</p>)}
    </div>)}
    {entry.stack.map((field, index) => <EvidenceField key={index} field={field} label={tc("fields.stack")} value={field.value} disabled onChange={() => {}} />)}
    {entry.items.length > 0 && <div className="flex flex-col gap-3">{entry.items.map((item) => <NestedReview key={item.key} entry={item} disabled={disabled} decision={decisions.find((value) => value.key === item.key)!} update={update} />)}</div>}
  </fieldset>;
}

function NestedReview({ entry, disabled, decision, update }: { entry: DraftEntry; disabled: boolean; decision: Decision; update: (decision: Decision) => void }) {
  const tc = useTranslations("career");
  const t = useTranslations("career.extract");
  return <fieldset disabled={disabled} className="flex min-w-0 flex-col gap-2 border-l-bw border-grid pl-3">
    <legend className="sr-only">{tc("fields.items")}</legend>
    <label className="flex gap-2"><input type="checkbox" checked={decision.action !== "skip"} onChange={(event) => update({ ...decision, action: event.target.checked ? "new" : "skip" })} />{t("include")}</label>
    {Object.entries(entry.fields).map(([key, field]) => field && <EvidenceField key={key} field={field} label={tc(`fields.${key as keyof typeof entry.fields}`)} value={decision.fields?.[key as keyof typeof entry.fields] ?? field.value} disabled={disabled} onChange={(value) => update({ ...decision, fields: { ...decision.fields, [key]: value } })} />)}
    {entry.bullets.map((field, index) => <div key={index}>
      <label className="flex gap-2"><input type="checkbox" checked={decision.bullets?.includes(field.value) ?? true} onChange={(event) => update({ ...decision, bullets: entry.bullets.map((value) => value.value).filter((value) => value === field.value ? event.target.checked : decision.bullets?.includes(value) ?? true) })} />{t("includeBullet", { number: index + 1 })}</label>
      <p className="break-words">{field.value}</p><blockquote className="text-data">{t("quote", { quote: field.quote })}</blockquote>{field.flags.map((flag) => <p key={flag} data-code={flag}>{t(`flags.${flag}`)}</p>)}
    </div>)}
  </fieldset>;
}

export function DraftReview({ draft, profile, baseHash, dirty, onAdopted, onRemoved, onAdopting }: {
  draft: CareerDraft; profile: CareerProfile; baseHash: string | null; dirty: boolean;
  onAdopted: (saved: Saved) => void; onRemoved: (adopted: boolean) => void; onAdopting?: (busy: boolean) => void;
}) {
  const t = useTranslations("career.extract");
  const tc = useTranslations("career");
  const [decisions, setDecisions] = useState<AdoptDecisions>(() => [
    ...(["headline", "summary"] as const).flatMap((key) => draft.sections[key] ? [{ key, action: "skip" as const }] : []),
    ...DRAFT_SECTIONS.flatMap((section) => draft.sections[section].flatMap((entry) => [
      { key: entry.key, action: "skip" as const, ...(entry.match ? { target: entry.match } : {}) },
      ...entry.items.map((item) => ({ key: item.key, action: "new" as const })),
    ])),
  ]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const update = (next: Decision) => setDecisions((old) => old.map((item) => item.key === next.key ? next : item));
  function fail(code: string) { setError(code); requestAnimationFrame(() => alert.current?.focus()); }
  async function run(adopt: boolean) {
    if (adopt) onAdopting?.(true);
    setBusy(true); setError(null);
    try {
      if (adopt) {
        const saved = await adoptCareerDraftAction({ requestId: draft.request_id, baseHash, decisions });
        if (saved.ok) { onAdopted(saved); if (saved.draftDiscarded) onRemoved(true); }
        else fail(saved.code);
      } else {
        const removed = await discardCareerDraftAction({ requestId: draft.request_id });
        if (removed.ok) onRemoved(false); else fail(removed.code);
      }
    } catch { fail("request_failed"); }
    finally { setBusy(false); if (adopt) onAdopting?.(false); }
  }
  return <div className="flex min-w-0 flex-col gap-4" data-testid="career-draft-review">
    {(["headline", "summary"] as const).map((key) => {
      const field = draft.sections[key]; const decision = decisions.find((item) => item.key === key);
      return field && decision && <fieldset key={key} disabled={busy} className="flex flex-col gap-2"><legend>{tc(`fields.${key}`)}</legend>
        <label className="flex gap-2"><input type="checkbox" checked={decision.action !== "skip"} onChange={(event) => update({ ...decision, action: event.target.checked ? "new" : "skip" })} />{t("include")}</label>
        <EvidenceField field={field} label={tc(`fields.${key}`)} value={decision.fields?.text ?? field.value} onChange={(text) => update({ ...decision, fields: { text } })} disabled={busy} />
      </fieldset>;
    })}
    {DRAFT_SECTIONS.map((section) => draft.sections[section].length > 0 && <section key={section} className="flex min-w-0 flex-col gap-3" aria-label={tc(`sections.${section}`)}>
      <h4 className="text-title-sm font-bold">{tc(`sections.${section}`)}</h4>
      {draft.sections[section].map((entry) => <EntryReview key={entry.key} entry={entry} section={section} decision={decisions.find((item) => item.key === entry.key)!} update={update} decisions={decisions} profile={profile} disabled={busy} />)}
    </section>)}
    {dirty && <p role="status">{t("saveFirst")}</p>}
    {error && <p ref={alert} tabIndex={-1} role="alert" data-code={error}>{tc(careerErrorMessageKey(error))}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="primary" disabled={busy || dirty || !decisions.some((item) => item.action !== "skip" && (["headline", "summary"].includes(item.key) || DRAFT_SECTIONS.some((section) => draft.sections[section].some((entry) => entry.key === item.key))))} onClick={() => void run(true)}>{t("adopt")}</Button><Button variant="outline" disabled={busy} onClick={() => void run(false)}>{t("discard")}</Button></div>
  </div>;
}
