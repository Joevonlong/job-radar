"use client";

import { useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { saveContactAction } from "@/app/career/actions";
import { savePreferencesAction } from "@/app/career/documents/actions";
import { Button } from "@/components/ui/button";
import { KIT_CONTACT_FIELDS, KIT_LAYOUT_FIELDS, KIT_SKIPPED } from "@/lib/career/import/fields";
import { careerContactSchema } from "@/lib/career/schema/contact";
import { preferencesSchema } from "@/lib/career/schema/preferences";

const hash = z.string().nullable();
const resultSchema = z.object({
  ok: z.literal(true),
  draftId: z.number().int().positive().nullable(),
  skipped: z.array(z.enum(KIT_SKIPPED)),
  contact: z.object({ incoming: careerContactSchema.pick({ name: true, address: true, location: true, email: true, phone: true, work_auth: true, availability: true, links: true }), current: careerContactSchema, baseHash: hash }),
  layout: z.object({ incoming: preferencesSchema.shape.layout.partial(), current: preferencesSchema, baseHash: hash }),
});
type Result = z.infer<typeof resultSchema>;
type ContactField = (typeof KIT_CONTACT_FIELDS)[number];

/** Imports a resume-kit YAML file: content goes to the pending drafts, contact values and layout are applied only when confirmed. */
export function KitImport({ maxBytes, onDraft }: { maxBytes: number; onDraft: () => void }) {
  const t = useTranslations("career.kitImport");
  const tf = useTranslations("career.fields");
  const router = useRouter();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [chosen, setChosen] = useState<Set<ContactField | "links" | "layout">>(new Set());
  const changedFields = result ? KIT_CONTACT_FIELDS.filter((key) => result.contact.incoming[key] !== null && result.contact.incoming[key] !== result.contact.current[key]) : [];
  const newLinks = result ? result.contact.incoming.links.filter((link) => !result.contact.current.links.some((old) => old.url === link.url)) : [];
  const layoutChanges = result ? KIT_LAYOUT_FIELDS.filter((key) => result.layout.incoming[key] !== undefined && result.layout.incoming[key] !== result.layout.current.layout[key]) : [];

  async function upload() {
    if (!file) return;
    setFailure(null); setNotice(null); setResult(null);
    if (file.size > maxBytes) { setFailure("too_large"); return; }
    setBusy(true);
    try {
      const response = await fetch("/api/career/import", { method: "POST", headers: { "Content-Type": "application/yaml" }, body: file });
      const raw: unknown = await response.json();
      const parsed = resultSchema.safeParse(raw);
      if (!parsed.success) {
        const error = z.object({ error: z.string() }).safeParse(raw);
        setFailure(error.success ? error.data.error : "unavailable");
        return;
      }
      setResult(parsed.data);
      setChosen(new Set(KIT_CONTACT_FIELDS.filter((key) => parsed.data.contact.incoming[key] !== null && parsed.data.contact.current[key] === null)));
      setFile(null); if (input.current) input.current.value = "";
      if (parsed.data.draftId !== null) onDraft();
    } catch { setFailure("unavailable"); }
    finally { setBusy(false); }
  }

  async function apply() {
    if (!result) return;
    setBusy(true); setFailure(null);
    try {
      const fields = changedFields.filter((key) => chosen.has(key));
      if (fields.length || (chosen.has("links") && newLinks.length)) {
        const contact = { ...result.contact.current, ...Object.fromEntries(fields.map((key) => [key, result.contact.incoming[key]])), links: chosen.has("links") ? [...result.contact.current.links, ...newLinks] : result.contact.current.links };
        const saved = await saveContactAction({ contact, baseHash: result.contact.baseHash });
        if (!saved.ok) { setFailure(saved.code); return; }
      }
      if (chosen.has("layout") && layoutChanges.length) {
        const preferences = { ...result.layout.current, layout: { ...result.layout.current.layout, ...result.layout.incoming } };
        const saved = await savePreferencesAction({ preferences, baseHash: result.layout.baseHash });
        if (!saved.ok) { setFailure(saved.code); return; }
      }
      setResult(null); setNotice("applied"); router.refresh();
    } catch { setFailure("unavailable"); }
    finally { setBusy(false); }
  }

  function toggle(key: ContactField | "links" | "layout", on: boolean) {
    setChosen((old) => { const next = new Set(old); if (on) next.add(key); else next.delete(key); return next; });
  }
  const errorKey = `errors.${failure}` as "errors.kit_invalid";
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="career-kit-import" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} className="text-title-sm font-bold">{t("title")}</h3>
      <p className="text-body-sm">{t("hint")}</p>
      <label htmlFor={`${id}-file`} className="text-label">{t("file")}</label>
      <input ref={input} id={`${id}-file`} type="file" accept=".yaml,.yml" className="max-w-full text-body-sm" disabled={busy} onChange={(event) => setFile(event.target.files?.[0] ?? null)} data-testid="career-kit-file" />
      <Button variant="outline" className="self-start" disabled={busy || !file} onClick={() => void upload()}>{t("upload")}</Button>
      {failure && <p role="alert" data-code={failure} className="text-bad break-words">{t.has(errorKey) ? t(errorKey) : t("errors.generic")}</p>}
      {notice && <p role="status">{t("applied")}</p>}
      {result && (
        <div className="flex min-w-0 flex-col gap-3" data-testid="career-kit-result">
          <p role="status">{result.draftId === null ? t("noContent") : t("drafted")}</p>
          {result.skipped.length > 0 && <p className="text-body-sm">{t("skipped", { parts: result.skipped.map((part) => t(`parts.${part}`)).join(", ") })}</p>}
          {changedFields.length + newLinks.length + layoutChanges.length === 0 ? <p className="text-body-sm">{t("nothingToApply")}</p> : (
            <fieldset disabled={busy} className="flex min-w-0 flex-col gap-2" data-testid="career-kit-contact">
              <legend className="text-label">{t("confirm")}</legend>
              {changedFields.map((key) => (
                <label key={key} className="flex min-w-0 gap-2 text-body-sm break-words">
                  <input type="checkbox" checked={chosen.has(key)} onChange={(event) => toggle(key, event.target.checked)} />
                  <span>{tf(key)}: {result.contact.current[key] ? t("change", { from: result.contact.current[key], to: result.contact.incoming[key] ?? "" }) : result.contact.incoming[key]}</span>
                </label>
              ))}
              {newLinks.length > 0 && (
                <label className="flex gap-2 text-body-sm">
                  <input type="checkbox" checked={chosen.has("links")} onChange={(event) => toggle("links", event.target.checked)} />
                  {t("links", { count: newLinks.length })}
                </label>
              )}
              {layoutChanges.length > 0 && (
                <label className="flex gap-2 text-body-sm">
                  <input type="checkbox" checked={chosen.has("layout")} onChange={(event) => toggle("layout", event.target.checked)} />
                  {t("layout", { fields: layoutChanges.map((key) => `${t(`layoutFields.${key}`)} ${String(result.layout.incoming[key])}`).join(", ") })}
                </label>
              )}
              <div className="flex gap-2">
                <Button variant="primary" disabled={busy || chosen.size === 0} onClick={() => void apply()} data-testid="career-kit-apply">{t("apply")}</Button>
                <Button variant="outline" disabled={busy} onClick={() => setResult(null)}>{t("dismiss")}</Button>
              </div>
            </fieldset>
          )}
        </div>
      )}
    </section>
  );
}
