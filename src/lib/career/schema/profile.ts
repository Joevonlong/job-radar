import { z } from "zod";

import type { CareerConfig } from "@/lib/config/schemas/career";
import { CareerStoreError } from "../contact/errors";
import type { IdPrefix } from "./ids";

/** File-format bounds stay independent of the smaller, configurable save limits. */
export const CAREER_FILE_BOUNDS = {
  entries: 1000,
  bullets: 100,
  wordings: 50,
  textChars: 20000,
  listItems: 100,
} as const;
const value = z.string().max(CAREER_FILE_BOUNDS.textChars);
const optionalValue = value.nullable().default(null);
const id = (prefix: IdPrefix) => z.string().regex(new RegExp(`^(?:${prefix}_[a-z2-7]{10})?$`));
export const careerDateSchema = z
  .string()
  .regex(/^(?:\d{4}(?:-(?:0[1-9]|1[0-2]))?|present)$/)
  .nullable()
  .default(null);
const date = careerDateSchema;
const url = z
  .url({ protocol: /^https?$/ })
  .max(CAREER_FILE_BOUNDS.textChars)
  .nullable()
  .default(null);
const strings = z.array(value).max(CAREER_FILE_BOUNDS.listItems).default([]);

export const wordingSchema = z.strictObject({
  id: id("wrd"),
  text: value,
  lang: optionalValue,
  label: optionalValue,
  origin: z.enum(["extracted", "manual", "from_document"]).default("manual"),
  from_document: optionalValue,
  from_story: optionalValue,
  created_at: z.iso.datetime({ offset: true }),
});
export const textSchema = z
  .strictObject({
    id: id("txt"),
    primary: id("wrd"),
    wordings: z.array(wordingSchema).min(1).max(CAREER_FILE_BOUNDS.wordings),
  })
  .superRefine((text, ctx) => {
    if (text.primary !== "" && !text.wordings.some((wording) => wording.id === text.primary))
      ctx.addIssue({ code: "custom", path: ["primary"], message: "invalid primary" });
  });
export type Text = z.infer<typeof textSchema>;
export type Wording = z.infer<typeof wordingSchema>;
const bullets = z.array(textSchema).max(CAREER_FILE_BOUNDS.bullets).default([]);
const entries = <T extends z.ZodType>(schema: T) => z.array(schema).max(CAREER_FILE_BOUNDS.entries).default([]);

export const experienceSchema = z.strictObject({
  id: id("exp"),
  company: value,
  url,
  location: optionalValue,
  start: date,
  end: date,
  role: textSchema,
  summary: textSchema.nullable().default(null),
  bullets,
  stack: strings,
});
export const projectSchema = z.strictObject({
  id: id("prj"),
  name: value,
  url,
  tagline: textSchema.nullable().default(null),
  bullets,
  stack: strings,
});
export const educationSchema = z.strictObject({
  id: id("edu"),
  school: value,
  url,
  degree: textSchema,
  location: optionalValue,
  start: date,
  end: date,
  summary: textSchema.nullable().default(null),
  bullets,
});
const customEntry = z.strictObject({
  id: id("itm"),
  kind: z.literal("entry"),
  heading: textSchema,
  sub: textSchema.nullable().default(null),
  url,
  date,
  start: date,
  end: date,
  location: optionalValue,
  tags: strings,
  text: textSchema.nullable().default(null),
  bullets,
});
const customText = z.strictObject({ id: id("itm"), kind: z.enum(["text", "bullet", "tag"]), text: textSchema });
export const customSectionSchema = z.strictObject({
  id: id("sec"),
  title: textSchema,
  layout: z.enum(["list", "grid", "tags"]),
  side: z.enum(["main", "aside"]),
  items: entries(z.discriminatedUnion("kind", [customEntry, customText])),
});
export type CustomSection = z.infer<typeof customSectionSchema>;

/** Visit structured fields without walking the primary-id references as if they defined ids. */
export function visitProfile(value: unknown, visit: (object: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) value.forEach((item) => visitProfile(item, visit));
  else if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    visit(object);
    Object.values(object).forEach((item) => visitProfile(item, visit));
  }
}

export const careerProfileSchema = z
  .strictObject({
    schema_version: z.literal(1).default(1),
    adopted_entries: z.array(z.string().regex(/^[1-9]\d*:(?:headline|summary|d\d+(?:\.\d+)*)$/)).default([]),
    headline: textSchema.nullable().default(null),
    summary: textSchema.nullable().default(null),
    experience: entries(experienceSchema),
    projects: entries(projectSchema),
    education: entries(educationSchema),
    certifications: entries(z.strictObject({ id: id("crt"), name: value, issuer: optionalValue, date })),
    languages: entries(
      z.strictObject({
        id: id("lng"),
        name: value,
        level: value,
        code: z
          .string()
          .regex(/^[a-z]{2}$/)
          .nullable()
          .default(null),
        cefr: z.enum(["A1", "A2", "B1", "B2", "C1", "C2", "native"]).nullable().default(null),
      }),
    ),
    skills: entries(
      z.strictObject({
        id: id("skg"),
        group: value,
        items: entries(
          z.strictObject({ id: id("skl"), name: value, years: z.number().min(0).max(100).nullable().default(null) }),
        ),
      }),
    ),
    approach: entries(z.strictObject({ id: id("apr"), title: value, text: textSchema })),
    custom_sections: entries(customSectionSchema),
  })
  .superRefine((profile, ctx) => {
    const seen = new Set<string>();
    let count = 0;
    visitProfile(profile, (object) => {
      if (typeof object.id !== "string") return;
      if (object.id && seen.has(object.id)) ctx.addIssue({ code: "custom", message: "duplicate id" });
      if (object.id) seen.add(object.id);
      if (!("wordings" in object) && !("created_at" in object)) count++;
    });
    if (count > CAREER_FILE_BOUNDS.entries) ctx.addIssue({ code: "custom", message: "too many entries" });
  });
export type CareerProfile = z.infer<typeof careerProfileSchema>;

export function emptyProfile(): CareerProfile {
  return careerProfileSchema.parse({});
}

export function profileContent(profile: CareerProfile): Omit<CareerProfile, "adopted_entries"> {
  const content: Omit<CareerProfile, "adopted_entries"> & { adopted_entries?: string[] } = { ...profile };
  delete content.adopted_entries;
  return content;
}

export function primaryText(text: Text | null): string {
  return text?.wordings.find((wording) => wording.id === text.primary)?.text ?? text?.wordings[0]?.text ?? "";
}

export function profileEntryCount(profile: CareerProfile): number {
  let count = 0;
  visitProfile(profile, (object) => {
    if (typeof object.id === "string" && !("wordings" in object) && !("created_at" in object)) count++;
  });
  return count;
}

export function checkProfileLimits(profile: CareerProfile, limits: CareerConfig["profile"]): void {
  if (profileEntryCount(profile) > limits.max_entries) throw new CareerStoreError("limits");
  visitProfile(profile, (object) => {
    if (Array.isArray(object.bullets) && object.bullets.length > limits.max_bullets_per_entry)
      throw new CareerStoreError("limits");
    if (Array.isArray(object.wordings) && object.wordings.length > limits.max_wordings_per_text)
      throw new CareerStoreError("limits");
    for (const [key, field] of Object.entries(object)) {
      if (["id", "primary", "created_at", "origin", "schema_version"].includes(key)) continue;
      if (typeof field === "string" && field.length > limits.text_max_chars) throw new CareerStoreError("limits");
      if (Array.isArray(field) && field.some((item) => typeof item === "string" && item.length > limits.text_max_chars))
        throw new CareerStoreError("limits");
    }
  });
}

/** On disk all ids must be assigned, and a primary wording must exist. */
export function parseStoredProfile(value: unknown): CareerProfile {
  const profile = careerProfileSchema.parse(value);
  visitProfile(profile, (object) => {
    if (object.id === "" || object.primary === "") throw new CareerStoreError("profile_invalid");
  });
  return profile;
}
