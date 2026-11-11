import { z } from "zod";

import {
  CAREER_LANGS, CAREER_THEMES, CAREER_PAPERS, CAREER_DENSITIES, careerAccentSchema,
} from "@/lib/config/schemas/career";
import { CareerStoreError } from "../contact/errors";
import { CAREER_FILE_BOUNDS, careerDateSchema, visitProfile } from "./profile";
import type { DocumentIdPrefix } from "./ids";

export const DOCUMENT_BUILTINS = ["summary", "approach", "experience", "projects", "skills", "education", "certifications", "languages"] as const;
export const documentIdSchema = z.string().regex(/^doc_[a-z2-7]{10}$/);
const id = (prefix: DocumentIdPrefix) => z.string().regex(new RegExp(`^(?:${prefix}_[a-z2-7]{10})?$`));
const value = z.string().max(CAREER_FILE_BOUNDS.textChars);
const optional = value.nullable().default(null);
const url = z.url({ protocol: /^https?$/ }).max(CAREER_FILE_BOUNDS.textChars).nullable().default(null);
const strings = z.array(value).max(CAREER_FILE_BOUNDS.listItems).default([]);
const entries = <T extends z.ZodType>(schema: T) => z.array(schema).max(CAREER_FILE_BOUNDS.entries).default([]);
const sourceId = z.string().regex(/^(?:exp|prj|edu|crt|lng|skg|skl|apr|sec|itm)_[a-z2-7]{10}$/);
const source = z.strictObject({ entry_id: sourceId }).nullable().default(null);
const base = { id: id("ent"), source, included: z.boolean() };

export const docTextSchema = z.strictObject({
  id: id("dtx"),
  source: z.strictObject({
    text_id: z.string().regex(/^txt_[a-z2-7]{10}$/),
    wording_id: z.string().regex(/^wrd_[a-z2-7]{10}$/),
  }).nullable(),
  text: value,
  origin: z.enum(["source", "ai", "user"]),
  included: z.boolean().optional(),
});
export type DocText = z.infer<typeof docTextSchema>;
const bullets = z.array(docTextSchema).max(CAREER_FILE_BOUNDS.bullets).default([]);
const maybeText = docTextSchema.nullable().default(null);
export const documentLayoutSchema = z.strictObject({
  lang: z.enum(CAREER_LANGS),
  theme: z.enum(CAREER_THEMES),
  accent: careerAccentSchema,
  pages: z.number().int().min(1).max(10),
  paper: z.enum(CAREER_PAPERS),
  density: z.enum(CAREER_DENSITIES),
  colors: z.enum(["quiet", "accent"]),
  filename: z.string().max(200).nullable(),
  sections: z.array(z.union([z.enum(DOCUMENT_BUILTINS), z.strictObject({ custom: id("ent").min(1) })]))
    .max(CAREER_FILE_BOUNDS.entries).nullable(),
  signature: z.strictObject({ place: optional, date: z.union([z.literal("auto"), z.iso.date()]) }).nullable(),
});
export const claimTargetSchema = z.union([
  z.strictObject({ text: id("dtx").min(1) }),
  z.strictObject({ entry: id("ent").min(1), field: value.min(1), value }),
  z.strictObject({ letter: z.enum(["recipient", "place", "date", "subject", "salutation", "closing"]) }),
]);
export const claimSchema = z.strictObject({
  id: z.string().regex(/^clm_[a-z2-7]{10}$/),
  target: claimTargetSchema,
  kind: z.enum(["figure", "skill", "duty", "fact"]),
  text: value.min(1),
  in_jd: z.boolean().default(false),
  translation: z.boolean().default(false),
  status: z.enum(["pending", "confirmed", "rejected", "noted"]),
  by: z.enum(["ai", "user"]),
});
export type Claim = z.infer<typeof claimSchema>;

export function buildDocumentSchema<U extends z.ZodType<string | null>>(url: U, accent = careerAccentSchema) {
  const customEntry = z.strictObject({
    ...base, kind: z.literal("entry"), heading: docTextSchema, sub: maybeText, url,
    date: careerDateSchema, start: careerDateSchema, end: careerDateSchema, location: optional,
    tags: strings, text: maybeText, bullets,
  });
  const customText = z.strictObject({ ...base, kind: z.enum(["text", "bullet", "tag"]), text: docTextSchema });

  return z.strictObject({
    schema_version: z.literal(1),
    id: id("doc"),
    title: value,
    kind: z.enum(["general", "tailored"]),
    job: z.strictObject({ id: z.number().int(), company: value, title: value, jd_hash: value }).nullable(),
    profile_hash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    created_at: z.iso.datetime({ offset: true }),
    updated_at: z.iso.datetime({ offset: true }),
    layout: documentLayoutSchema.extend({ accent }),
    hide_contact: z.array(z.enum(["address", "location", "email", "phone", "work_auth", "availability", "links", "photo"]))
      .max(8).refine((items) => new Set(items).size === items.length),
    requirements: strings,
    headline: maybeText,
    summary: maybeText,
    experience: entries(z.strictObject({
      ...base, company: value, url, location: optional, start: careerDateSchema, end: careerDateSchema,
      stack: strings, role: docTextSchema, summary: maybeText, bullets,
    })),
    projects: entries(z.strictObject({ ...base, name: value, url, tagline: maybeText, bullets, stack: strings })),
    education: entries(z.strictObject({
      ...base, school: value, url, degree: docTextSchema, location: optional, start: careerDateSchema, end: careerDateSchema,
      summary: maybeText, bullets,
    })),
    certifications: entries(z.strictObject({ ...base, name: value, issuer: optional, date: careerDateSchema })),
    languages: entries(z.strictObject({ ...base, name: value, level: value })),
    skills: entries(z.strictObject({
      ...base, group: value, items: entries(z.strictObject({
        id: id("itm"),
        source: z.strictObject({ item_id: z.string().regex(/^skl_[a-z2-7]{10}$/) }).nullable().default(null),
        name: value, included: z.boolean(),
      })),
    })),
    approach: entries(z.strictObject({ ...base, title: value, text: docTextSchema })),
    custom_sections: entries(z.strictObject({
      ...base, title: docTextSchema, layout: z.enum(["list", "grid", "tags"]),
      columns: z.number().int().min(1).max(4).nullable(), side: z.enum(["main", "aside"]),
      items: entries(z.discriminatedUnion("kind", [customEntry, customText])),
    })),
    letter: z.strictObject({
      recipient: strings, place: optional, date: z.iso.date().nullable(), subject: optional, salutation: optional,
      body: bullets, closing: optional,
    }).nullable(),
    claims: z.array(claimSchema).max(CAREER_FILE_BOUNDS.entries),
  }).superRefine((document, ctx) => {
    const seen = new Set<string>();
    let count = 0;
    visitProfile(document, (object) => {
      if (typeof object.id !== "string") return;
      if (object.id && seen.has(object.id)) ctx.addIssue({ code: "custom", message: "duplicate id" });
      if (object.id) seen.add(object.id);
      if (!("origin" in object) && !("schema_version" in object) && !("target" in object)) count++;
    });
    if (count > CAREER_FILE_BOUNDS.entries) ctx.addIssue({ code: "custom", message: "too many entries" });
  });
}

export const documentSchema = buildDocumentSchema(url);
export type CareerDocument = z.infer<typeof documentSchema>;

export function parseStoredDocument(raw: unknown): CareerDocument {
  const result = documentSchema.safeParse(raw);
  if (!result.success) throw new CareerStoreError("document_invalid");
  visitProfile(result.data, (object) => {
    if (object.id === "") throw new CareerStoreError("document_invalid");
  });
  return result.data;
}
