/** The stored shape of a breakdown (`job_breakdowns.content`) and its readers. */
import { z } from "zod";

import { BREAKDOWN_PROMPT_VERSION } from "@/lib/ai/prompts/breakdown";

import { REQUIREMENT_LEVELS, SPOKEN_LEVELS, TECH_CATEGORIES } from "./constants";

const located = { quote: z.string().min(1), offset: z.number().int().min(0) };
const requirement = z.enum(REQUIREMENT_LEVELS);
const storedItem = z.strictObject({ text: z.string().min(1), requirement, ...located });

export const breakdownContentSchema = z.strictObject({
  responsibilities: z.array(z.strictObject({ text: z.string().min(1), ...located })),
  tech_stack: z.array(z.strictObject({ name: z.string().min(1), category: z.enum(TECH_CATEGORIES), requirement, ...located })),
  experience: z.strictObject({
    years_min: z.number().int().min(0).nullable(),
    years_quote: z.strictObject(located).nullable(),
    items: z.array(storedItem),
  }),
  projects: z.array(storedItem),
  soft_skills: z.array(storedItem),
  languages: z.array(z.strictObject({ language: z.string().min(1), level: z.enum(SPOKEN_LEVELS), requirement, ...located })),
  other: z.array(storedItem),
});
export type BreakdownContent = z.infer<typeof breakdownContentSchema>;

/** One schema per prompt version whose rows can still be shown. */
const CONTENT_SCHEMAS: Readonly<Record<string, z.ZodType<BreakdownContent>>> = { [BREAKDOWN_PROMPT_VERSION]: breakdownContentSchema };

/** The stored content, or null when the version is unknown or the content does not match its schema (C6). */
export function parseStoredBreakdown(promptVersion: string, content: unknown): BreakdownContent | null {
  const schema = CONTENT_SCHEMAS[promptVersion];
  if (!schema) return null;
  const parsed = schema.safeParse(content);
  return parsed.success ? parsed.data : null;
}

/** Items of every list (the years line counts as one when set). */
export function countItems(content: BreakdownContent): number {
  return (
    content.responsibilities.length +
    content.tech_stack.length +
    content.experience.items.length +
    (content.experience.years_min !== null ? 1 : 0) +
    content.projects.length +
    content.soft_skills.length +
    content.languages.length +
    content.other.length
  );
}

export function isEmptyBreakdown(content: BreakdownContent): boolean {
  return countItems(content) === 0;
}
