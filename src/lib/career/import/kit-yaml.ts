/**
 * A resume-kit master résumé splits into three parts: contact values the user confirms field by field, profile content
 * that becomes a draft for the normal review, and layout preferences. No AI call is involved, so draft fields carry no
 * quote and only the contact flag. Photos, approach notes, targets and letters are not imported and are only counted.
 */
import { parseResume, type Resume } from "@/lib/career/engine";
import { careerLayoutDefaultsSchema, type CareerConfig } from "@/lib/config/schemas/career";
import { careerContactSchema, type CareerContact } from "../schema/contact";
import { CAREER_FILE_BOUNDS, careerDateSchema } from "../schema/profile";
import { findPiiIn } from "@/lib/stories/pii";
import { KIT_SKIPPED, type KIT_CONTACT_FIELDS } from "./fields";
import { draftFields, draftSectionsSchema, type DraftEntry, type DraftSections, type VerifiedField } from "../extract/verify";

export type KitContact = Pick<CareerContact, (typeof KIT_CONTACT_FIELDS)[number] | "links">;
export type KitLayout = Partial<CareerConfig["document"]["defaults"]>;
export interface KitImport {
  contact: KitContact;
  layout: KitLayout;
  language: string;
  sections: DraftSections;
  skipped: (typeof KIT_SKIPPED)[number][];
  entries: number;
}
type CustomItem = Extract<NonNullable<Resume["sections"]>[number], { items: unknown }>["items"][number];

const clip = (value: string) => value.trim().slice(0, CAREER_FILE_BOUNDS.textChars);
const field = (value: string | undefined): VerifiedField | null => value?.trim() ? { value: clip(value), quote: "", flags: [] } : null;
const dateField = (value: string | undefined): VerifiedField | null => {
  if (!value?.trim()) return null;
  return careerDateSchema.safeParse(value.trim()).success ? field(value) : { value: "", quote: "", flags: ["date_invalid"] };
};
const list = (values: string[] | undefined) => (values ?? []).map(field).filter((item): item is VerifiedField => item !== null).slice(0, 100);

function contactOf(basics: Resume["basics"]): KitContact {
  const text = (value: string | string[] | undefined) => {
    const joined = Array.isArray(value) ? value.join("\n") : value;
    return joined?.trim() ? clip(joined) : null;
  };
  const link = careerContactSchema.shape.links.unwrap().element;
  return {
    name: text(basics.name), address: text(basics.address), location: text(basics.location), email: text(basics.email),
    phone: text(basics.phone), work_auth: text(basics.workAuth), availability: text(basics.availability),
    links: basics.links.flatMap((item) => {
      const parsed = link.safeParse({ label: clip(item.label), url: item.url.trim() });
      return parsed.success ? [parsed.data] : [];
    }).slice(0, 100),
  };
}

function layoutOf(meta: Resume["meta"]): KitLayout {
  const shape = careerLayoutDefaultsSchema.shape;
  const layout: KitLayout = {};
  const lang = shape.lang.safeParse(meta.lang);
  if (lang.success) layout.lang = lang.data;
  const theme = shape.theme.safeParse(meta.theme);
  if (theme.success) layout.theme = theme.data;
  const accent = shape.accent.safeParse(meta.accent);
  if (accent.success) layout.accent = accent.data;
  const pages = shape.pages.safeParse(meta.pages);
  if (pages.success) layout.pages = pages.data;
  const paper = shape.paper.safeParse(meta.paper);
  if (paper.success) layout.paper = paper.data;
  const density = shape.density.safeParse(meta.density);
  if (density.success) layout.density = density.data;
  return layout;
}

/** Marks draft texts that repeat a contact value of the file or look like an email address or phone number, so review catches them. */
function flagContact(sections: DraftSections, contact: KitContact): void {
  const values = [contact.name, contact.email, contact.phone, ...(contact.address?.split("\n") ?? [])]
    .map((value) => value?.trim().toLowerCase() ?? "").filter((value) => value.length > 0);
  for (const field of draftFields(sections)) {
    const text = field.value.toLowerCase();
    if (!field.flags.includes("pii") && (findPiiIn([field.value]).length > 0 || values.some((value) => text.includes(value)))) field.flags.push("pii");
  }
}

function customItem(item: CustomItem, key: string): DraftEntry {
  const base = { key, match: null, bullets: [], stack: [], items: [] };
  if (item.kind === "entry") {
    return {
      ...base, kind: "entry", bullets: list(item.bullets),
      fields: { heading: field(item.heading), sub: field(item.sub), date: dateField(item.start), text: field(item.text) },
    };
  }
  const text = item.kind === "group" ? `${item.label}: ${item.items.join(", ")}` : item.kind === "tag" ? item.tag.text : item.text;
  return { ...base, kind: "text", fields: { text: field(text) } };
}

/** Parses the uploaded YAML with the rendering engine's schema; an invalid file yields only a code. */
export function importKitYaml(text: string): { ok: true; result: KitImport } | { ok: false; code: "kit_invalid" } {
  const parsed = parseResume(text);
  if (!parsed.ok) return { ok: false, code: "kit_invalid" };
  const resume = parsed.resume;
  let next = 0;
  const key = () => `d${++next}`;
  const entry = (fields: DraftEntry["fields"], extra: Partial<DraftEntry> = {}): DraftEntry => ({
    key: key(), match: null, kind: "entry", fields, bullets: [], stack: [], items: [], ...extra,
  });
  const custom = (resume.sections ?? []).flatMap((section) => typeof section === "string" || "use" in section ? [] : [section]);
  const sections = {
    headline: field(resume.basics.title),
    summary: field(resume.basics.summary),
    experience: resume.experience.map((item) => entry(
      { company: field(item.company), role: field(item.role), location: field(item.location), start: dateField(item.start), end: dateField(item.end), summary: field(item.summary) },
      { bullets: list(item.bullets), stack: list(item.stack) },
    )),
    projects: resume.projects.map((item) => entry({ name: field(item.name), tagline: field(item.tagline) }, { bullets: list(item.bullets), stack: list(item.stack) })),
    education: resume.education.map((item) => entry(
      { school: field(item.school), degree: field(item.degree), location: field(item.location), start: dateField(item.start), end: dateField(item.end), summary: field(item.summary) },
      { bullets: list(item.bullets) },
    )),
    certifications: resume.certifications.map((item) => entry({ name: field(item.name), issuer: field(item.issuer), date: dateField(item.date) })),
    languages: resume.languages.map((item) => entry({ name: field(item.name), level: field(item.level) })),
    skills: resume.skills.map((group) => {
      const parent = entry({ group: field(group.group) });
      parent.items = group.items.slice(0, 1000).map((name) => ({ key: `${parent.key}.${key().slice(1)}`, match: null, kind: "entry" as const, fields: { name: field(name) }, bullets: [], stack: [], items: [] }));
      return parent;
    }),
    custom_sections: custom.map((section) => {
      const parent = entry({ title: field(section.title) });
      parent.items = section.items.slice(0, 1000).map((item) => customItem(item, `${parent.key}.${key().slice(1)}`));
      return parent;
    }),
  };
  const bounded = Object.fromEntries(Object.entries(sections).map(([name, value]) => [name, Array.isArray(value) ? value.slice(0, 1000) : value]));
  const skipped = KIT_SKIPPED.filter((name) => name === "photo" ? Boolean(resume.basics.photo) : name === "approach" ? resume.approach.length > 0 : resume[name] !== undefined);
  const draft = draftSectionsSchema.parse(bounded);
  const contact = contactOf(resume.basics);
  flagContact(draft, contact);
  const entries = next;
  return { ok: true, result: { contact, layout: layoutOf(resume.meta), language: resume.meta.lang, sections: draft, skipped, entries } };
}
