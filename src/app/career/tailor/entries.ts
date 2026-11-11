import { primaryText } from "@/lib/career/schema/profile";
import { loadCareerProfile } from "@/lib/career/store/profile";
import { readProposals } from "@/lib/career/tailor/proposals";
import { logActionFailure } from "@/lib/logging/action-failure";

/** Whether a document has suggestions to review, and the profile entries with bullets a new wording can be saved to. */
export async function tailorEntries(docId: string): Promise<{ hasProposals: boolean; entries: { id: string; label: string }[] }> {
  const [proposals, loaded] = await Promise.allSettled([readProposals(docId), loadCareerProfile()]);
  if (proposals.status === "rejected") logActionFailure("careerTailorProposals", proposals.reason);
  if (loaded.status === "rejected") logActionFailure("careerTailorEntries", loaded.reason);
  const profile = loaded.status === "fulfilled" ? loaded.value.profile : null;
  const entries = profile ? [
    ...profile.experience.map((entry) => ({ id: entry.id, label: [entry.company, primaryText(entry.role)].filter(Boolean).join(" · ") })),
    ...profile.projects.map((entry) => ({ id: entry.id, label: entry.name })),
    ...profile.education.map((entry) => ({ id: entry.id, label: [entry.school, primaryText(entry.degree)].filter(Boolean).join(" · ") })),
  ].map((entry) => ({ ...entry, label: entry.label || entry.id })) : [];
  return { hasProposals: proposals.status === "fulfilled" && Boolean(proposals.value?.items.length), entries };
}
