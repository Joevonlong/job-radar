import { z } from "zod";
import type { CareerConfig } from "@/lib/config/schemas/career";
import { emptyProfile, careerProfileSchema } from "../schema/profile";
import { assignIds } from "../schema/ids";
import { generateDocument } from "../document/generate";
import { proposalInputSchema } from "./proposal-schema";
import { verifyProposal } from "./verify";

export const calibrationSampleSchema = z.strictObject({
  id: z.string().min(1), label: z.enum(["supported", "new_duty", "new_skill", "cross_language"]),
  must_catch: z.boolean().default(false), lang: z.enum(["en", "de"]), pool: z.array(z.string()).min(1),
  jd: z.string(), text: z.string(), support: z.array(z.string()), source_lang: z.string().nullable().default(null),
});
export const calibrationSamplesSchema = z.array(calibrationSampleSchema);
export type CalibrationSample = z.infer<typeof calibrationSampleSchema>;

export function calibrate(samples: CalibrationSample[], settings: CareerConfig, threshold: number) {
  const groups = new Map<string, { supported: number; unsupported: number; misses: number; falseAlarms: number; missedMustCatch: string[] }>();
  for (const sample of samples) {
    const config = structuredClone(settings); config.tailor.duty_min_coverage = threshold;
    const wording = { id: "", text: sample.pool.join(" "), lang: sample.source_lang, origin: "manual", created_at: "2026-01-01T00:00:00Z" };
    const profile = assignIds(careerProfileSchema.parse({ summary: { id: "", primary: "", wordings: [wording] } }), emptyProfile());
    const doc = generateDocument(profile, null, { ...config.document.defaults, lang: sample.lang }, "2026-01-01T00:00:00Z", "Calibration");
    const item = verifyProposal(proposalInputSchema.parse({ action: "rewrite", target: { text: doc.summary!.id }, text: sample.text, support: sample.support.map((quote) => ({ quote })) }), {
      doc, profile, pool: { all: sample.pool.join("\n"), entries: {} }, jd: sample.jd, settings: config, sentIds: ["summary"], allowed: ["rewrite"],
    });
    const flagged = item === null || item.claims.some((claim) => claim.by === "ai" && claim.status === "pending");
    const group = groups.get(sample.lang) ?? { supported: 0, unsupported: 0, misses: 0, falseAlarms: 0, missedMustCatch: [] };
    if (sample.label === "supported") { group.supported++; if (flagged) group.falseAlarms++; }
    else { group.unsupported++; if (!flagged) group.misses++; }
    if (sample.must_catch && !flagged) group.missedMustCatch.push(sample.id);
    groups.set(sample.lang, group);
  }
  return [...groups].map(([lang, group]) => ({ lang, ...group, missRate: group.unsupported ? group.misses / group.unsupported : 0, falseAlarmRate: group.supported ? group.falseAlarms / group.supported : 0 }));
}
