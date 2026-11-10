import { careerExtractOutputSchema, type CareerExtractOutput } from "@/lib/career/extract/prompt";
import { verifyCareerExtract } from "@/lib/career/extract/verify";
import { careerSchema } from "@/lib/config/schemas/career";
import type { CareerDraft } from "@/lib/career/extract/draft-store";

export const field = (value: string, quote = value) => ({ value, quote });
export const SOURCE = "Example Engineer 2020 Built a service and reduced errors by 40%.";
export const settings = () => careerSchema.parse({ enabled: true });
export function output(patch: Partial<CareerExtractOutput> = {}): CareerExtractOutput {
  return careerExtractOutputSchema.parse({ language: "en", experience: [{ company: field("Example"), role: field("Engineer"), start: field("2020"), bullets: [field("Built a service")] }], ...patch });
}
export function draft(id = 1): CareerDraft {
  return { schema_version: 1, request_id: id, origin: "resume", source_hash: "a".repeat(64), created_at: "2026-01-01T00:00:00Z", language: "en", sections: verifyCareerExtract(SOURCE, output(), settings().evidence) };
}
