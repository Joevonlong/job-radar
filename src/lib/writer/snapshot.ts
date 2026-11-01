/**
 * The snapshot of one writing request, taken by the web when the user presses "write": the question with its settings,
 * the job's title and company, and the selected material as it is at that moment (the breakdown's JD points, the
 * profile of me.yaml, the stories of stories.yaml, the emphasis note). The ai-worker writes from it and checks against
 * it, so a file edited meanwhile changes nothing of a running request. Pure: the caller loads the inputs.
 */
import type { MeConfig, Story, WriterConfig } from "@/lib/config";
import type { QuestionKind, LengthUnit } from "@/lib/config/schemas/writer";

import { resolveJdPoints, type JdPoint } from "./jd-points";
import type { ProfileSnapshot, StorySnapshot, WriterMaterials } from "./materials";
import type { QuestionSelection, QuestionSettings } from "./types";

export interface SnapshotInput {
  question: QuestionSettings;
  selection: QuestionSelection;
  job: { title: string; company: string };
  /** The JD points of the current breakdown (empty without one). */
  jdPoints: readonly JdPoint[];
  me: MeConfig | null;
  stories: readonly Story[];
  writer: WriterConfig;
}

export interface Snapshot {
  materials: WriterMaterials;
  /** Chosen JD points the breakdown no longer has / chosen stories the library no longer has (both left out). */
  stale: { jdPoints: number; stories: number };
}

export function profileSnapshot(me: MeConfig): ProfileSnapshot {
  return {
    summary: me.summary,
    skills: me.skills.map((skill) => (skill.years === null ? skill.name : `${skill.name} (${skill.years}y)`)),
    languages: me.languages.flatMap((entry) => Object.entries(entry).map(([code, level]) => `${code} ${level}`)),
  };
}

export function storySnapshot(story: Story): StorySnapshot {
  return { id: story.id, title: story.title, what: story.what, result: story.result ?? null, metrics: story.metrics, skills: story.skills, period: story.period ?? null };
}

/** The variants (style id + hint) a question of `kind` asks for: the first `variants` of writer.yaml `variants`. */
export function variantsFor(writer: WriterConfig, kind: QuestionKind): { id: string; hint: string }[] {
  return writer.variants.slice(0, writer.questions.kinds[kind].variants).map((variant) => ({ id: variant.id, hint: variant.hint }));
}

export function buildSnapshot(input: SnapshotInput): Snapshot {
  const { question, selection, writer } = input;
  const jd = resolveJdPoints(input.jdPoints, selection.jdPoints);
  const byId = new Map(input.stories.map((story) => [story.id, story]));
  const stories = selection.storyIds.flatMap((id) => {
    const story = byId.get(id);
    return story ? [storySnapshot(story)] : [];
  });
  const emphasis = selection.emphasis.trim().slice(0, writer.emphasis_max_chars);
  const materials: WriterMaterials = {
    question: {
      text: question.text.slice(0, writer.questions.text_max_chars),
      kind: question.kind,
      lengthUnit: question.lengthUnit satisfies LengthUnit,
      lengthValue: question.lengthValue,
      outputLanguage: question.outputLanguage,
      tone: question.tone,
      variants: variantsFor(writer, question.kind),
    },
    job: input.job,
    jdPoints: jd.points.map((point) => ({ text: point.text, quote: point.quote, offset: point.offset, requirement: point.requirement })),
    useJdText: selection.useJdText,
    profile: selection.profile && input.me !== null ? profileSnapshot(input.me) : null,
    stories,
    emphasis: emphasis === "" ? null : emphasis,
  };
  return { materials, stale: { jdPoints: jd.stale, stories: selection.storyIds.length - stories.length } };
}
