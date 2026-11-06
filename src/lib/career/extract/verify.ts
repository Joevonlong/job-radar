import { z } from "zod";

import type { CareerConfig } from "@/lib/config/schemas/career";
import { findPiiIn } from "@/lib/stories/pii";
import { verifyExtractField, type ExtractedField } from "@/lib/stories/verify-extract";
import type { CareerExtractOutput } from "./prompt";

export const CAREER_EXTRACT_FLAGS = ["quote_missing", "quote_too_short", "figure_missing", "year_missing", "date_invalid", "pii"] as const;
export const verifiedFieldSchema = z.strictObject({
  value: z.string().max(20000),
  quote: z.string().max(20000),
  flags: z.array(z.enum(CAREER_EXTRACT_FLAGS)).max(CAREER_EXTRACT_FLAGS.length),
});
export type VerifiedField = z.infer<typeof verifiedFieldSchema>;
export interface DraftEntry {
  key: string;
  match: string | null;
  kind: "entry" | "text";
  fields: Partial<Record<DraftFieldName, VerifiedField | null>>;
  bullets: VerifiedField[];
  stack: VerifiedField[];
  items: DraftEntry[];
}
export const DRAFT_FIELDS = [
  "company", "role", "location", "start", "end", "summary", "name", "tagline", "school", "degree", "issuer", "date",
  "level", "group", "title", "heading", "sub", "text",
] as const;
type DraftFieldName = typeof DRAFT_FIELDS[number];
export const draftEntrySchema: z.ZodType<DraftEntry> = z.lazy(() => z.strictObject({
  key: z.string().regex(/^d\d+(?:\.\d+)*$/), match: z.string().max(100).nullable(), kind: z.enum(["entry", "text"]),
  fields: z.partialRecord(z.enum(DRAFT_FIELDS), verifiedFieldSchema.nullable()),
  bullets: z.array(verifiedFieldSchema).max(100), stack: z.array(verifiedFieldSchema).max(100), items: z.array(draftEntrySchema).max(1000),
}));
export const DRAFT_SECTIONS = ["experience", "projects", "education", "certifications", "languages", "skills", "custom_sections"] as const;
export const draftSectionsSchema = z.strictObject({
  headline: verifiedFieldSchema.nullable(), summary: verifiedFieldSchema.nullable(),
  experience: z.array(draftEntrySchema).max(1000),
  projects: z.array(draftEntrySchema).max(1000),
  education: z.array(draftEntrySchema).max(1000),
  certifications: z.array(draftEntrySchema).max(1000),
  languages: z.array(draftEntrySchema).max(1000),
  skills: z.array(draftEntrySchema).max(1000),
  custom_sections: z.array(draftEntrySchema).max(1000),
});
export type DraftSections = z.infer<typeof draftSectionsSchema>;

export function verifyCareerField(source: string, field: ExtractedField, config: CareerConfig["evidence"], date = false): VerifiedField {
  const checked = verifyExtractField(source, date ? { value: "", quote: field.quote } : field, config);
  const flags: VerifiedField["flags"] = checked.flag ? [checked.flag] : [];
  const value = field.value.trim();
  if (date && value && !/^(?:\d{4}(?:-(?:0[1-9]|1[0-2]))?|present)$/.test(value)) flags.push("date_invalid");
  if (date && value !== "present" && /^\d{4}/.test(value)
    && !new RegExp(`(?<!\\d)${value.slice(0, 4)}(?!\\d)`).test(checked.quote)) {
    flags.push("year_missing");
  }
  if (findPiiIn([value, checked.quote]).length) flags.push("pii");
  return { value: flags.includes("date_invalid") ? "" : value, quote: checked.quote, flags };
}

export function verifyCareerExtract(source: string, output: CareerExtractOutput, config: CareerConfig["evidence"]): DraftSections {
  let next = 0;
  const check = (field: ExtractedField) => verifyCareerField(source, field, config);
  const entry = (raw: object): DraftEntry => {
    const result: DraftEntry = { key: `d${++next}`, match: null, kind: "entry", fields: {}, bullets: [], stack: [], items: [] };
    for (const [key, value] of Object.entries(raw) as [string, unknown][]) {
      if (key === "kind") {
        result.kind = value as DraftEntry["kind"];
        continue;
      }
      if (key === "bullets" || key === "stack") {
        result[key] = (value as ExtractedField[]).map(check);
        continue;
      }
      if (key === "items") {
        result.items = (value as object[]).map((item) => "value" in item ? entry({ name: item }) : entry(item));
        continue;
      }
      if (!DRAFT_FIELDS.includes(key as DraftFieldName)) continue;
      const field = typeof value === "string" ? { value, quote: value } : value as ExtractedField | null;
      result.fields[key as DraftFieldName] = field
        ? verifyCareerField(source, field, config, ["start", "end", "date"].includes(key))
        : null;
    }
    return result;
  };
  return draftSectionsSchema.parse({
    headline: output.headline ? check(output.headline) : null, summary: output.summary ? check(output.summary) : null,
    ...Object.fromEntries(DRAFT_SECTIONS.map((section) => [section, output[section].map(entry)])),
  });
}

export function draftFields(sections: DraftSections): VerifiedField[] {
  const fields: VerifiedField[] = [sections.headline, sections.summary].filter((field): field is VerifiedField => field !== null);
  const visit = (entry: DraftEntry) => {
    fields.push(...Object.values(entry.fields).filter((field): field is VerifiedField => field != null), ...entry.bullets, ...entry.stack);
    entry.items.forEach(visit);
  };
  DRAFT_SECTIONS.forEach((section) => sections[section].forEach(visit));
  return fields;
}
