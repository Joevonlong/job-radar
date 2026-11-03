/** What the sentences of an answer are checked against, from the snapshot of its material: the same for every way an answer comes in. */
import type { WriterEvidenceConfig } from "@/lib/config/schemas/writer";

import { companyEvidenceText } from "./company-background";
import { profileEvidenceText, storyEvidenceText, type WriterMaterials } from "./materials";
import type { VerifyContext } from "./verify";

/** The skill names of the profile snapshot ("Python (5 years)" -> "Python"). */
const skillName = (entry: string): string => entry.replace(/\s*\(\d+(?:\.\d+)?(?: years|y)\)$/u, "");

export function writerVerifyContext(input: {
  /** The stored (raw) JD. */
  jd: string;
  materials: WriterMaterials;
  /** The technologies of the job's breakdown. */
  techStack: readonly string[];
  company: string;
  evidence: WriterEvidenceConfig;
}): VerifyContext {
  const { materials } = input;
  return {
    jd: input.jd,
    profile: materials.profile ? profileEvidenceText(materials.profile) : null,
    stories: new Map(materials.stories.map((story) => [story.id, storyEvidenceText(story)])),
    emphasis: materials.emphasis,
    draft: materials.draft ? (materials.draft.evidenceText ?? materials.draft.text) : null,
    company: materials.company === null ? null : companyEvidenceText(materials.company),
    entities: [...input.techStack, ...materials.stories.flatMap((story) => story.skills), ...(materials.profile?.skills.map(skillName) ?? []), input.company],
    companyName: input.company,
    language: materials.question.outputLanguage,
    config: input.evidence,
  };
}
