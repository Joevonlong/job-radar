import { careerSchema } from "@/lib/config/schemas/career";
import { assignIds } from "@/lib/career/schema/ids";
import { emptyProfile } from "@/lib/career/schema/profile";
import { generateDocument } from "@/lib/career/document/generate";
import { factPool } from "@/lib/career/ai/view";
import { profile } from "./fixtures";

export const tailorSettings = () => careerSchema.parse({ enabled: true, tailor: {
  duty_min_coverage: 0.7, stopwords: {
    en: ["a", "an", "the", "and", "of", "to", "in", "with", "for", "by", "i", "my", "was", "as"],
    de: ["der", "die", "das", "den", "dem", "ein", "eine", "und", "mit", "von", "zu", "für", "in", "im", "als", "bei"],
  },
} });
export function tailorFixture(value = "Reduced nightly batch time from 4h to 40min") {
  const source = profile(value);
  source.experience[0]!.bullets[0]!.wordings[0]!.lang = "en";
  const stored = assignIds(source, emptyProfile());
  const settings = tailorSettings();
  const doc = generateDocument(stored, "a".repeat(64), settings.document.defaults, "2026-01-01T00:00:00Z", "Example");
  const text = doc.experience[0]!.bullets[0]!;
  return { doc, text, profile: stored, settings, pool: factPool(stored, (text) => text), jd: "We need someone who led a cross-functional team using kubernetes and Kafka", sentIds: [doc.experience[0]!.id], allowed: ["rewrite", "shorten", "add", "include", "drop", "reorder"] as const };
}
