"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { documentSchema, type CareerDocument, type DocText } from "@/lib/career/schema/document";
import type { SourceStates } from "@/lib/career/document/resolve";
import { DocumentInput } from "./document-shared";

export const documentSections = [
  "experience",
  "projects",
  "education",
  "certifications",
  "languages",
  "skills",
  "approach",
  "custom_sections",
] as const;
type Section = (typeof documentSections)[number];
type DataObject = Record<string, unknown>;
type Field = {
  key: string;
  kind?: "text" | "optionalText" | "lines" | "bullets" | "skills" | "custom" | "number";
  options?: readonly string[];
};
const facts = (...keys: string[]): Field[] => keys.map((key) => ({ key }));
const rich = (key: string): Field => ({ key, kind: "text" });
const optionalText = (key: string): Field => ({ key, kind: "optionalText" });
const bullets: Field = { key: "bullets", kind: "bullets" };
const customFields: Field[] = [
  rich("heading"),
  optionalText("sub"),
  ...facts("url", "date", "start", "end", "location"),
  { key: "tags", kind: "lines" },
  optionalText("text"),
  bullets,
];
const fields: Record<Section, Field[]> = {
  experience: [
    ...facts("company", "url", "location", "start", "end"),
    rich("role"),
    optionalText("summary"),
    bullets,
    { key: "stack", kind: "lines" },
  ],
  projects: [...facts("name", "url"), optionalText("tagline"), bullets, { key: "stack", kind: "lines" }],
  education: [...facts("school", "url", "location", "start", "end"), rich("degree"), optionalText("summary"), bullets],
  certifications: facts("name", "issuer", "date"),
  languages: facts("name", "level"),
  skills: [...facts("group"), { key: "items", kind: "skills" }],
  approach: [...facts("title"), rich("text")],
  custom_sections: [
    rich("title"),
    { key: "layout", options: ["list", "grid", "tags"] },
    { key: "columns", kind: "number" },
    { key: "side", options: ["main", "aside"] },
    { key: "items", kind: "custom" },
  ],
};

export function blankDocText(): DocText {
  return { id: "", source: null, text: "", origin: "user" };
}

export function moveDocumentItem<T>(items: T[], index: number, offset: number): T[] {
  const target = index + offset;
  if (target < 0 || target >= items.length) return items;
  const next = [...items];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

export function DocumentText({
  value,
  label,
  states,
  onChange,
}: {
  value: DocText;
  label: string;
  states: SourceStates;
  onChange: (value: DocText) => void;
}) {
  const t = useTranslations("career.documents");
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <DocumentInput
        label={label}
        value={value.text}
        multiline
        onChange={(text) => onChange({ ...value, text, origin: "user" })}
      />
      <div className="flex flex-wrap gap-1">
        {states.texts[value.id] && <Badge>{t(`source.${states.texts[value.id]}`)}</Badge>}
        {value.origin === "user" && <Badge data-testid="document-edited">{t("edited")}</Badge>}
      </div>
    </div>
  );
}

export function DocumentList({
  items,
  states,
  onChange,
  create,
  children,
  label,
}: {
  items: DataObject[];
  states: SourceStates;
  onChange: (items: DataObject[]) => void;
  create: () => DataObject;
  children: (item: DataObject, change: (item: DataObject) => void, index: number) => React.ReactNode;
  label: string;
}) {
  const t = useTranslations("career.documents");
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-2 text-title">{label}</legend>
      {items.map((item, index) => (
        <fieldset
          key={String(item.id || index)}
          data-testid="document-entry"
          className="flex min-w-0 flex-col gap-3 rounded-card border-bw border-grid p-3"
        >
          <legend className="text-label">{t("entry", { number: index + 1 })}</legend>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-label">
              <Checkbox
                checked={item.included !== false}
                onCheckedChange={(included) =>
                  onChange(items.map((old, at) => (at === index ? { ...old, included: included === true } : old)))
                }
              />
              {t("include")}
            </label>
            {states.entries[String(item.id)] && <Badge>{t("source.source_deleted")}</Badge>}
            <Button
              variant="ghost"
              size="sm"
              disabled={index === 0}
              onClick={() => onChange(moveDocumentItem(items, index, -1))}
            >
              {t("up")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={index === items.length - 1}
              onClick={() => onChange(moveDocumentItem(items, index, 1))}
            >
              {t("down")}
            </Button>
            {item.source === null && (
              <Button variant="ghost" size="sm" onClick={() => onChange(items.filter((_, at) => at !== index))}>
                {t("remove")}
              </Button>
            )}
          </div>
          {children(item, (next) => onChange(items.map((old, at) => (at === index ? next : old))), index)}
        </fieldset>
      ))}
      <Button variant="outline" onClick={() => onChange([...items, create()])}>
        {t("addEntry")}
      </Button>
    </fieldset>
  );
}

export function DocumentBullets({
  value,
  onChange,
  states,
  label,
}: {
  value: DocText[];
  onChange: (value: DocText[]) => void;
  states: SourceStates;
  label: string;
}) {
  const t = useTranslations("career.documents");
  return (
    <DocumentList
      label={label}
      items={value}
      states={states}
      onChange={(next) => onChange(next as DocText[])}
      create={blankDocText}
    >
      {(item, change, index) => (
        <DocumentText
          label={t("bullet", { number: index + 1 })}
          value={item as DocText}
          states={states}
          onChange={change}
        />
      )}
    </DocumentList>
  );
}

function blankEntry(section: Section): DataObject {
  return documentSchema.shape[section].unwrap().element.parse({
    id: "",
    source: null,
    included: true,
    ...{
      experience: { company: "", role: blankDocText() },
      projects: { name: "" },
      education: { school: "", degree: blankDocText() },
      certifications: { name: "" },
      languages: { name: "", level: "" },
      skills: { group: "", items: [] },
      approach: { title: "", text: blankDocText() },
      custom_sections: { title: blankDocText(), layout: "list", columns: null, side: "main", items: [] },
    }[section],
  });
}

function blankCustom(kind: string): DataObject {
  return kind === "entry"
    ? {
        id: "",
        source: null,
        included: true,
        kind,
        heading: blankDocText(),
        sub: null,
        url: null,
        date: null,
        start: null,
        end: null,
        location: null,
        tags: [],
        text: null,
        bullets: [],
      }
    : { id: "", source: null, included: true, kind, text: blankDocText() };
}

function changeCustomKind(item: DataObject, kind: string): DataObject {
  return {
    ...blankCustom(kind),
    id: item.id,
    source: item.source,
    included: item.included,
    ...(kind === "entry" ? { heading: item.heading ?? item.text } : { text: item.text ?? item.heading }),
  };
}

function parseFieldInput(field: Field, text: string): string | number | null {
  if (field.kind === "number") return text ? Number(text) : null;
  return text || (["url", "location", "issuer", "date", "start", "end"].includes(field.key) ? null : "");
}

function DocumentObject({
  value,
  onChange,
  fields,
  states,
}: {
  value: DataObject;
  onChange: (value: DataObject) => void;
  fields: Field[];
  states: SourceStates;
}) {
  const t = useTranslations("career.documents");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {fields.map((field) => {
        const label = t(`fields.${field.key}` as Parameters<typeof t>[0]);
        const current = value[field.key];
        const change = (next: unknown) => onChange({ ...value, [field.key]: next });
        if (field.options) {
          return (
            <label key={field.key} className="flex flex-col gap-1 text-label">
              {label}
              <NativeSelect value={String(current)} onChange={(event) => change(event.target.value)}>
                {field.options.map((option) => (
                  <option key={option} value={option}>
                    {t(`options.${option}` as Parameters<typeof t>[0])}
                  </option>
                ))}
              </NativeSelect>
            </label>
          );
        }
        if (field.kind === "text" || field.kind === "optionalText") {
          return (
            <div key={field.key}>
              {current ? (
                <>
                  <DocumentText value={current as DocText} label={label} states={states} onChange={change} />
                  {field.kind === "optionalText" && (
                    <Button variant="ghost" onClick={() => change(null)}>
                      {t("clearField", { label })}
                    </Button>
                  )}
                </>
              ) : (
                <Button variant="outline" onClick={() => change(blankDocText())}>
                  {t("addField", { label })}
                </Button>
              )}
            </div>
          );
        }
        if (field.kind === "bullets") {
          return (
            <DocumentBullets
              key={field.key}
              label={label}
              value={current as DocText[]}
              onChange={change}
              states={states}
            />
          );
        }
        if (field.kind === "lines") {
          return (
            <label key={field.key} className="flex min-w-0 flex-col gap-1 text-label">
              {label}
              <Textarea
                value={(current as string[]).join("\n")}
                onChange={(event) => change(event.target.value.split("\n"))}
              />
              <span className="text-body-sm text-ink-2">{t("linesHint")}</span>
            </label>
          );
        }
        if (field.kind === "skills" || field.kind === "custom") {
          return (
            <DocumentList
              key={field.key}
              label={label}
              items={current as DataObject[]}
              states={states}
              onChange={change}
              create={() =>
                field.kind === "skills" ? { id: "", source: null, included: true, name: "" } : blankCustom("entry")
              }
            >
              {(item, update) => (
                <>
                  {field.kind === "custom" && item.source === null && (
                    <label className="flex flex-col gap-1 text-label">
                      {t("fields.kind")}
                      <NativeSelect
                        value={String(item.kind)}
                        onChange={(event) => update(changeCustomKind(item, event.target.value))}
                      >
                        {["entry", "text", "bullet", "tag"].map((kind) => (
                          <option key={kind} value={kind}>
                            {t(`options.${kind}` as Parameters<typeof t>[0])}
                          </option>
                        ))}
                      </NativeSelect>
                    </label>
                  )}
                  <DocumentObject
                    value={item}
                    onChange={update}
                    fields={
                      field.kind === "skills" ? facts("name") : item.kind === "entry" ? customFields : [rich("text")]
                    }
                    states={states}
                  />
                </>
              )}
            </DocumentList>
          );
        }
        return (
          <DocumentInput
            key={field.key}
            label={label}
            value={current === null ? null : String(current)}
            type={field.kind === "number" ? "number" : "text"}
            onChange={(text) => change(parseFieldInput(field, text))}
          />
        );
      })}
    </div>
  );
}

export function DocumentContent({
  document,
  states,
  onChange,
}: {
  document: CareerDocument;
  states: SourceStates;
  onChange: (value: CareerDocument) => void;
}) {
  const t = useTranslations("career.documents");
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <DocumentInput
        label={t("fields.title")}
        value={document.title}
        onChange={(title) => onChange({ ...document, title })}
      />
      <DocumentObject
        value={document}
        onChange={(value) => onChange(value as CareerDocument)}
        fields={[optionalText("headline"), optionalText("summary")]}
        states={states}
      />
      {documentSections.map((section) => (
        <section key={section} data-testid={`document-${section}`} className="min-w-0">
          <DocumentList
            label={t(`sections.${section}`)}
            items={document[section]}
            states={states}
            onChange={(items) => onChange({ ...document, [section]: items })}
            create={() => blankEntry(section)}
          >
            {(item, update) => (
              <DocumentObject value={item} onChange={update} fields={fields[section]} states={states} />
            )}
          </DocumentList>
        </section>
      ))}
    </div>
  );
}

export function DocumentContact({
  value,
  onChange,
}: {
  value: CareerDocument["hide_contact"];
  onChange: (value: CareerDocument["hide_contact"]) => void;
}) {
  const t = useTranslations("career.documents");
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-2 text-title">{t("contact")}</legend>
      {documentSchema.shape.hide_contact.element.options.map((field) => (
        <label key={field} className="flex items-center gap-2 text-label">
          <Checkbox
            checked={value.includes(field)}
            onCheckedChange={(checked) =>
              onChange(checked === true ? [...value, field] : value.filter((name) => name !== field))
            }
          />
          {t("hideContact", { field: t(`contactFields.${field}`) })}
        </label>
      ))}
    </fieldset>
  );
}
