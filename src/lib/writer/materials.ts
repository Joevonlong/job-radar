/**
 * The material of one writing request: what the web takes from the question's selection at queue time (the snapshot the
 * ai-worker writes from and checks against), the AI input built from it, and the list of what is sent (the disclosure).
 * The input and the disclosure come from the same function (`writeInputFields`), so the page never lists less than goes out.
 */
import { z } from "zod";

import { LENGTH_UNITS, QUESTION_KINDS } from "@/lib/config/schemas/writer";
import { REQUIREMENT_LEVELS } from "@/lib/breakdown/constants";

import type { WriteInputField } from "./types";

const text = (max: number) => z.string().max(max);
const list = z.array(z.string().max(500)).max(100);

export const storySnapshotSchema = z.strictObject({
  id: z.string().min(1).max(80),
  title: text(1000),
  what: text(20_000),
  result: text(20_000).nullable(),
  metrics: list,
  skills: list,
  period: text(500).nullable(),
});
export type StorySnapshot = z.infer<typeof storySnapshotSchema>;

export const profileSnapshotSchema = z.strictObject({
  summary: text(4000),
  skills: list,
  /** "en C1", "de B2": code and level. */
  languages: list,
});
export type ProfileSnapshot = z.infer<typeof profileSnapshotSchema>;

export const jdPointSnapshotSchema = z.strictObject({
  text: text(1000),
  quote: text(2000),
  offset: z.number().int().min(0),
  requirement: z.enum(REQUIREMENT_LEVELS).nullable(),
});
export type JdPointSnapshot = z.infer<typeof jdPointSnapshotSchema>;

export const writerMaterialsSchema = z.strictObject({
  question: z.strictObject({
    text: text(10_000).min(1),
    kind: z.enum(QUESTION_KINDS),
    lengthUnit: z.enum(LENGTH_UNITS),
    lengthValue: z.number().int().min(1).max(10_000),
    outputLanguage: z.string().min(2).max(35),
    tone: z.string().min(1).max(40),
    variants: z.array(z.strictObject({ id: z.string().min(1).max(40), hint: text(200) })).min(1).max(5),
  }),
  job: z.strictObject({ title: text(1000), company: text(1000) }),
  jdPoints: z.array(jdPointSnapshotSchema).max(200),
  useJdText: z.boolean(),
  profile: profileSnapshotSchema.nullable(),
  stories: z.array(storySnapshotSchema).max(1000),
  emphasis: text(5000).nullable(),
});
export type WriterMaterials = z.infer<typeof writerMaterialsSchema>;

/** What of `materials` goes to the AI, in disclosure order. The question, its settings and the job's title and company always do. */
export function writeInputFields(materials: { jdPoints: readonly unknown[]; useJdText: boolean; profile: unknown; stories: readonly unknown[]; emphasis: string | null }): WriteInputField[] {
  const fields: WriteInputField[] = ["question", "settings", "job"];
  if (materials.jdPoints.length > 0) fields.push("jd_points");
  if (materials.useJdText) fields.push("jd_excerpt");
  if (materials.profile !== null) fields.push("profile");
  if (materials.stories.length > 0) fields.push("stories");
  if (materials.emphasis !== null && materials.emphasis.trim() !== "") fields.push("emphasis");
  return fields;
}

/** A story as one text: the evidence a `story` quote is looked up in. */
export function storyEvidenceText(story: StorySnapshot): string {
  return [story.title, story.what, story.result ?? "", ...story.metrics, ...story.skills, story.period ?? ""].filter((part) => part !== "").join("\n");
}

/** The profile as one text: the evidence a `profile` quote is looked up in. */
export function profileEvidenceText(profile: ProfileSnapshot): string {
  return [profile.summary, ...profile.skills, ...profile.languages].filter((part) => part !== "").join("\n");
}

/** The AI input (one JSON object). `jdExcerpt`: the cleaned JD excerpt, null when the job has none. */
export interface WriteInput {
  input: Record<string, unknown>;
  fields: WriteInputField[];
}

/**
 * The input object of the `write` prompt from the material: exactly the parts `writeInputFields` lists (the JD excerpt
 * only when one is given). The JD points carry their JD quote; their text is the breakdown's.
 */
export function buildWriteInput(materials: WriterMaterials, jdExcerpt: string | null): WriteInput {
  const { question } = materials;
  const parts: Partial<Record<WriteInputField, unknown>> = {
    question: question.text,
    settings: {
      kind: question.kind,
      length: { unit: question.lengthUnit, value: question.lengthValue },
      output_language: question.outputLanguage,
      tone: question.tone,
      versions: question.variants.map((variant) => ({ id: variant.id, style: variant.hint })),
    },
    job: { title: materials.job.title, company: materials.job.company },
  };
  if (materials.jdPoints.length > 0) parts.jd_points = materials.jdPoints.map((point) => ({ text: point.text, quote: point.quote, ...(point.requirement ? { requirement: point.requirement } : {}) }));
  if (materials.useJdText && jdExcerpt !== null) parts.jd_excerpt = jdExcerpt;
  if (materials.profile !== null) parts.profile = materials.profile;
  if (materials.stories.length > 0) parts.stories = materials.stories.map((story) => ({ id: story.id, title: story.title, what: story.what, result: story.result, metrics: story.metrics, skills: story.skills, period: story.period }));
  if (materials.emphasis !== null && materials.emphasis.trim() !== "") parts.emphasis = materials.emphasis;
  const fields = writeInputFields(materials).filter((field) => field in parts);
  const input: Record<string, unknown> = {};
  for (const field of fields) input[field] = parts[field];
  return { input, fields };
}
