import { primaryText, type CareerProfile } from "../schema/profile";
import type { DraftEntry, DraftSections } from "./verify";

export const normalizeCareerText = (text: string) => text.normalize("NFKC")
  .toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const normalizeCareerContent = (text: string) => text.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
const sameContent = (a: string | null | undefined, b: string | null | undefined) =>
  normalizeCareerContent(a ?? "") === normalizeCareerContent(b ?? "");
const equal = (a: string | null | undefined, b: string | null | undefined) =>
  normalizeCareerText(a ?? "") === normalizeCareerText(b ?? "");
type MatchSection = keyof Omit<DraftSections, "headline" | "summary">;

export function matchExperience(profile: CareerProfile, entry: DraftEntry): string | null {
  return profile.experience.find((candidate) => equal(candidate.company, entry.fields.company?.value)
    && equal(candidate.start, entry.fields.start?.value)
    && candidate.role.wordings.some((wording) => sameContent(wording.text, entry.fields.role?.value)))?.id ?? null;
}

export function matchCareerEntry(profile: CareerProfile, section: MatchSection, entry: DraftEntry): string | null {
  if (section === "experience") return matchExperience(profile, entry);
  if (section === "education") {
    return profile.education.find((item) => equal(item.school, entry.fields.school?.value)
      && equal(item.start, entry.fields.start?.value)
      && item.degree.wordings.some((wording) => sameContent(wording.text, entry.fields.degree?.value)))?.id ?? null;
  }
  if (section === "custom_sections") {
    return profile.custom_sections.find((item) => sameContent(primaryText(item.title), entry.fields.title?.value))?.id ?? null;
  }
  if (section === "skills") return profile.skills.find((item) => sameContent(item.group, entry.fields.group?.value))?.id ?? null;
  return profile[section].find((item) => sameContent(item.name, entry.fields.name?.value))?.id ?? null;
}

export function suggestCareerMatches(profile: CareerProfile, sections: DraftSections): DraftSections {
  const result = structuredClone(sections);
  for (const section of ["experience", "projects", "education", "certifications", "languages", "skills", "custom_sections"] as const) {
    result[section].forEach((entry) => { entry.match = matchCareerEntry(profile, section, entry); });
  }
  return result;
}
