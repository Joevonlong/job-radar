"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { savePreferencesAction } from "@/app/career/documents/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { CAREER_DENSITIES, CAREER_LANGS, CAREER_PAPERS, CAREER_THEMES } from "@/lib/config/schemas/career";
import { DOCUMENT_BUILTINS, documentLayoutSchema, type CareerDocument } from "@/lib/career/schema/document";
import type { CareerPreferences } from "@/lib/career/schema/preferences";
import { moveDocumentItem } from "./document-fields";
import { DocumentInput, DocumentStatus } from "./document-shared";

type Layout = CareerDocument["layout"];
const pageBudget = documentLayoutSchema.shape.pages;
const pageOptions = Array.from(
  { length: pageBudget.maxValue! - pageBudget.minValue! + 1 },
  (_, index) => pageBudget.minValue! + index,
);
export function documentSectionOrder(document: CareerDocument): NonNullable<Layout["sections"]> {
  const custom = document.custom_sections.filter((section) => section.included && section.id);
  const current = document.layout.sections ?? [...DOCUMENT_BUILTINS];
  const kept = current.filter((ref) => typeof ref === "string" || custom.some((section) => section.id === ref.custom));
  return [
    ...kept,
    ...DOCUMENT_BUILTINS.filter((key) => !kept.includes(key)),
    ...custom
      .filter((section) => !kept.some((ref) => typeof ref !== "string" && ref.custom === section.id))
      .map((section) => ({ custom: section.id })),
  ];
}

export function DocumentLayout({
  document,
  onChange,
  initialPreferences,
}: {
  document: CareerDocument;
  onChange: (layout: Layout) => void;
  initialPreferences: { preferences: CareerPreferences; baseHash: string | null };
}) {
  const t = useTranslations("career.documents");
  const layout = document.layout;
  const [preferences, setPreferences] = useState(initialPreferences);
  const [emphasis, setEmphasis] = useState(initialPreferences.preferences.emphasis);
  const [tone, setTone] = useState(initialPreferences.preferences.tone);
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState("");
  const [pending, startTransition] = useTransition();
  const order = documentSectionOrder(document);
  const patch = (next: Partial<Layout>) => onChange({ ...layout, ...next });
  function saveDefaults() {
    startTransition(async () => {
      try {
        const { lang, theme, accent, pages, paper, density } = layout;
        const result = await savePreferencesAction({
          preferences: { schema_version: 1, layout: { lang, theme, accent, pages, paper, density }, emphasis, tone },
          baseHash: preferences.baseHash,
        });
        if (!result.ok) {
          setStatus(result.code);
          return;
        }
        setPreferences(result);
        setStatus("saved");
        setOpen(false);
      } catch {
        setStatus("request_failed");
      }
    });
  }
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="document-layout">
      {(
        [
          { key: "theme", options: CAREER_THEMES },
          { key: "lang", options: CAREER_LANGS },
          { key: "paper", options: CAREER_PAPERS },
          { key: "density", options: CAREER_DENSITIES },
          { key: "colors", options: ["quiet", "accent"] },
        ] as const
      ).map(({ key, options }) => (
        <label key={key} className="flex flex-col gap-1 text-label">
          {t(`layoutFields.${key}`)}
          <NativeSelect value={layout[key]} onChange={(event) => patch({ [key]: event.target.value })}>
            {options.map((option) => (
              <option key={option} value={option}>
                {t(`options.${option}`)}
              </option>
            ))}
          </NativeSelect>
        </label>
      ))}
      <label className="flex flex-col gap-1 text-label">
        {t("layoutFields.accent")}
        <div className="flex min-w-0 gap-2">
          <Input
            aria-label={t("accentPicker")}
            type="color"
            className="w-14 shrink-0"
            value={/^#[\da-f]{6}$/i.test(layout.accent) ? layout.accent : "#000000"}
            onChange={(event) => patch({ accent: event.target.value })}
          />
          <Input
            aria-label={t("layoutFields.accent")}
            value={layout.accent}
            onChange={(event) => patch({ accent: event.target.value })}
          />
        </div>
      </label>
      <label className="flex flex-col gap-1 text-label">
        {t("layoutFields.pages")}
        <NativeSelect value={layout.pages} onChange={(event) => patch({ pages: Number(event.target.value) })}>
          {pageOptions.map((pages) => (
            <option key={pages} value={pages}>
              {pages}
            </option>
          ))}
        </NativeSelect>
      </label>
      <DocumentInput
        label={t("layoutFields.filename")}
        value={layout.filename}
        onChange={(filename) => patch({ filename: filename || null })}
      />
      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2 text-title">{t("sectionOrder")}</legend>
        {document.custom_sections.some((section) => section.included && !section.id) && (
          <p className="text-body-sm text-ink-2">{t("saveSectionFirst")}</p>
        )}
        <ol className="flex min-w-0 flex-col gap-2">
          {order.map((ref, index) => (
            <li key={typeof ref === "string" ? ref : ref.custom} className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 break-words">
                {typeof ref === "string"
                  ? t(`sections.${ref}`)
                  : document.custom_sections.find((section) => section.id === ref.custom)?.title.text}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("moveSectionUp", { number: index + 1 })}
                disabled={index === 0}
                onClick={() => patch({ sections: moveDocumentItem(order, index, -1) })}
              >
                {t("up")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("moveSectionDown", { number: index + 1 })}
                disabled={index === order.length - 1}
                onClick={() => patch({ sections: moveDocumentItem(order, index, 1) })}
              >
                {t("down")}
              </Button>
            </li>
          ))}
        </ol>
        <Button variant="outline" onClick={() => patch({ sections: null })}>
          {t("resetOrder")}
        </Button>
      </fieldset>
      <label className="flex items-center gap-2 text-label">
        <Switch
          checked={layout.signature !== null}
          onCheckedChange={(checked) => patch({ signature: checked ? { place: null, date: "auto" } : null })}
        />
        {t("signature")}
      </label>
      {layout.signature && (
        <>
          <DocumentInput
            label={t("letterFields.place")}
            value={layout.signature.place}
            onChange={(place) => patch({ signature: { ...layout.signature!, place: place || null } })}
          />
          <label className="flex flex-col gap-1 text-label">
            {t("signatureDate")}
            <NativeSelect
              value={layout.signature.date === "auto" ? "auto" : "fixed"}
              onChange={(event) =>
                patch({ signature: { ...layout.signature!, date: event.target.value === "auto" ? "auto" : "" } })
              }
            >
              <option value="auto">{t("options.auto")}</option>
              <option value="fixed">{t("options.fixed")}</option>
            </NativeSelect>
          </label>
          {layout.signature.date !== "auto" && (
            <DocumentInput
              label={t("letterFields.date")}
              value={layout.signature.date}
              type="date"
              onChange={(date) => patch({ signature: { ...layout.signature!, date } })}
            />
          )}
        </>
      )}
      <Button
        variant="outline"
        onClick={() => {
          setStatus("");
          setOpen(true);
        }}
      >
        {t("saveDefaults")}
      </Button>
      <DocumentStatus code={open ? "" : status} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogTitle>{t("defaultsTitle")}</DialogTitle>
          <DialogDescription>{t("defaultsHint")}</DialogDescription>
          <DocumentInput label={t("emphasis")} value={emphasis} multiline onChange={setEmphasis} />
          <DocumentInput label={t("tone")} value={tone} multiline onChange={setTone} />
          <DocumentStatus code={status} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button onClick={saveDefaults} disabled={pending}>
              {t("saveDefaults")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
