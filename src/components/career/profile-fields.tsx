"use client";

import { useTranslations } from "next-intl";
import type messages from "../../../messages/en.json";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { CareerConfig } from "@/lib/config/schemas/career";
import { educationSchema, experienceSchema, projectSchema, type Text } from "@/lib/career/schema/profile";
import { TextEditor, blankText } from "./text-editor";

type Key = keyof typeof messages.career.fields;
type Kind = "value" | "number" | "date" | "list" | "rich" | "optionalRich" | "bullets" | "items" | "customItems";
type Field = { key: Key; nullable?: boolean; kind?: Kind; options?: readonly (keyof typeof messages.career.options)[] };
export type SectionKey = keyof typeof messages.career.sections;
type NounKey = keyof typeof messages.career.nouns;
type NestedKind = Extract<Kind, NounKey>;
const NOUN_KEYS: readonly string[] = ["headline", "summary", "sub", "text", "tagline"] satisfies NounKey[];
export type DataObject = Record<string, unknown>;
const facts = (...keys: Key[]): Field[] =>
  keys.map((key) => ({ key, nullable: ["url", "location", "issuer", "code", "cefr"].includes(key) }));
const rich = (key: Key): Field => ({ key, kind: "rich" });
const dates: Field[] = [
  { key: "start", kind: "date" },
  { key: "end", kind: "date" },
];
const bulletField: Field = { key: "bullets", kind: "bullets" };
const entryFields: Field[] = [
  rich("heading"),
  { key: "sub", kind: "optionalRich" },
  ...facts("url", "location"),
  { key: "date", kind: "date" },
  ...dates,
  { key: "tags", kind: "list" },
  { key: "text", kind: "optionalRich" },
  bulletField,
];
const skillFields: Field[] = [...facts("name"), { key: "years", kind: "number" }];

export const sectionFields: Record<SectionKey, Field[]> = {
  experience: [
    ...facts("company", "url", "location"),
    ...dates,
    rich("role"),
    { key: "summary", kind: "optionalRich" },
    bulletField,
    { key: "stack", kind: "list" },
  ],
  projects: [
    ...facts("name", "url"),
    { key: "tagline", kind: "optionalRich" },
    bulletField,
    { key: "stack", kind: "list" },
  ],
  education: [
    ...facts("school", "url", "location"),
    ...dates,
    rich("degree"),
    { key: "summary", kind: "optionalRich" },
    bulletField,
  ],
  certifications: [...facts("name", "issuer"), { key: "date", kind: "date" }],
  languages: facts("name", "level", "code", "cefr"),
  skills: [...facts("group"), { key: "items", kind: "items" }],
  approach: [...facts("title"), rich("text")],
  custom_sections: [
    rich("title"),
    { key: "layout", options: ["list", "grid", "tags"] },
    { key: "side", options: ["main", "aside"] },
    { key: "items", kind: "customItems" },
  ],
};
export const sectionKeys = Object.keys(sectionFields) as SectionKey[];

export function blankEntry(section: SectionKey): DataObject {
  switch (section) {
    case "experience":
      return experienceSchema.parse({ id: "", company: "", role: blankText() });
    case "projects":
      return projectSchema.parse({ id: "", name: "" });
    case "education":
      return educationSchema.parse({ id: "", school: "", degree: blankText() });
    case "certifications":
      return { id: "", name: "", issuer: null, date: null };
    case "languages":
      return { id: "", name: "", level: "", code: null, cefr: null };
    case "skills":
      return { id: "", group: "", items: [] };
    case "approach":
      return { id: "", title: "", text: blankText() };
    case "custom_sections":
      return { id: "", title: blankText(), layout: "list", side: "main", items: [] };
  }
}

function customItem(kind: string): DataObject {
  if (kind !== "entry") return { id: "", kind, text: blankText() };
  return {
    id: "",
    kind,
    heading: blankText(),
    sub: null,
    url: null,
    date: null,
    start: null,
    end: null,
    location: null,
    tags: [],
    text: null,
    bullets: [],
  };
}

type Limits = CareerConfig["profile"];
type FieldProps = {
  field: Field;
  value: unknown;
  onChange: (value: unknown) => void;
  limits: Limits;
};

function RichTextField({ field, value, onChange, limits }: FieldProps) {
  const t = useTranslations("career");
  const label = t(`fields.${field.key}`);
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-label">{label}</legend>
      {value ? (
        <>
          <TextEditor
            value={value as Text}
            onChange={onChange}
            maxWordings={limits.max_wordings_per_text}
            maxChars={limits.text_max_chars}
          />
          {field.kind === "optionalRich" && (
            <Button type="button" variant="ghost" onClick={() => onChange(null)}>
              {t("remove")}
            </Button>
          )}
        </>
      ) : (
        <Button type="button" variant="outline" onClick={() => onChange(blankText())}>
          {t("addField", { label: NOUN_KEYS.includes(field.key) ? t(`nouns.${field.key as NounKey}`) : label })}
        </Button>
      )}
    </fieldset>
  );
}

function ListField({ field, value, onChange }: FieldProps) {
  const t = useTranslations("career");
  return (
    <label className="flex min-w-0 flex-col gap-1 text-label">
      {t(`fields.${field.key}`)}
      <Textarea value={(value as string[]).join("\n")} onChange={(event) => onChange(event.target.value.split("\n"))} />
      <span className="text-body-sm text-ink-2">{t("listHint")}</span>
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: unknown;
  options: readonly (keyof typeof messages.career.options)[];
  onChange: (value: string) => void;
}) {
  const t = useTranslations("career");
  return (
    <label className="flex flex-col gap-1 text-label">
      {label}
      <select
        className="h-ctl-md min-w-0 rounded-btn border-bw border-ink bg-card px-2"
        value={String(value)}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {t(`options.${option}`)}
          </option>
        ))}
      </select>
    </label>
  );
}

function PlainInputField({ field, value, onChange, limits }: FieldProps) {
  const t = useTranslations("career");
  function change(input: string) {
    if (field.kind === "number") {
      onChange(input === "" ? null : Number(input));
      return;
    }
    const empty = field.nullable || field.kind === "date" ? null : "";
    onChange(input || empty);
  }
  return (
    <label className="flex min-w-0 flex-col gap-1 text-label">
      {t(`fields.${field.key}`)}
      <Input
        type={field.kind === "number" ? "number" : "text"}
        maxLength={limits.text_max_chars}
        value={typeof value === "number" || typeof value === "string" ? value : ""}
        onChange={(event) => change(event.target.value)}
      />
      {field.kind === "date" && <span className="text-body-sm text-ink-2">{t("dateHint")}</span>}
    </label>
  );
}

function NestedItem({
  kind,
  item,
  onChange,
  limits,
}: {
  kind: Kind;
  item: DataObject;
  onChange: (value: unknown) => void;
  limits: Limits;
}) {
  const t = useTranslations("career");
  if (kind === "bullets") {
    return (
      <TextEditor
        value={item as unknown as Text}
        onChange={onChange}
        maxWordings={limits.max_wordings_per_text}
        maxChars={limits.text_max_chars}
      />
    );
  }
  let fields = skillFields;
  if (kind === "customItems") fields = item.kind === "entry" ? entryFields : [rich("text")];
  return (
    <>
      {kind === "customItems" && (
        <SelectField
          label={t("fields.kind")}
          value={item.kind}
          options={["entry", "text", "bullet", "tag"]}
          onChange={(value) => onChange({ ...customItem(value), id: item.id })}
        />
      )}
      <ObjectFields value={item} onChange={onChange} fields={fields} limits={limits} />
    </>
  );
}

function NestedItemsField({ field, value, onChange, limits }: FieldProps) {
  const t = useTranslations("career");
  const label = t(`fields.${field.key}`);
  const kind = field.kind as NestedKind;
  const noun = t(`nouns.${kind}`);
  const items = value as DataObject[];
  const maxItems = kind === "bullets" ? limits.max_bullets_per_entry : limits.max_entries;
  function addItem() {
    let next: DataObject | Text;
    if (kind === "bullets") next = blankText();
    else if (kind === "items") next = { id: "", name: "", years: null };
    else next = customItem("entry");
    onChange([...items, next]);
  }
  return (
    <fieldset className="min-w-0">
      <legend className="mb-2 text-label">{label}</legend>
      <div className="flex min-w-0 flex-col gap-3">
        {items.map((item, index) => (
          <div key={String(item.id || index)} className="min-w-0 rounded-card border-bw border-grid p-3">
            <NestedItem
              kind={kind}
              item={item}
              onChange={(next) => onChange(items.map((old, at) => (at === index ? next : old)))}
              limits={limits}
            />
            <Button type="button" variant="ghost" onClick={() => onChange(items.filter((_, at) => at !== index))}>
              {t("removeField", { label: noun })}
            </Button>
          </div>
        ))}
        <Button type="button" variant="outline" disabled={items.length >= maxItems} onClick={addItem}>
          {t("addField", { label: noun })}
        </Button>
      </div>
    </fieldset>
  );
}

function ProfileField(props: FieldProps) {
  const t = useTranslations("career");
  const { field, value, onChange } = props;
  if (field.options) {
    return <SelectField label={t(`fields.${field.key}`)} value={value} options={field.options} onChange={onChange} />;
  }
  switch (field.kind) {
    case "rich":
    case "optionalRich":
      return <RichTextField {...props} />;
    case "list":
      return <ListField {...props} />;
    case "bullets":
    case "items":
    case "customItems":
      return <NestedItemsField {...props} />;
    default:
      return <PlainInputField {...props} />;
  }
}

export function ObjectFields({
  value,
  onChange,
  fields,
  limits,
}: {
  value: DataObject;
  onChange: (value: DataObject) => void;
  fields: Field[];
  limits: Limits;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {fields.map((field) => (
        <ProfileField
          key={field.key}
          field={field}
          value={value[field.key]}
          onChange={(next) => onChange({ ...value, [field.key]: next })}
          limits={limits}
        />
      ))}
    </div>
  );
}
