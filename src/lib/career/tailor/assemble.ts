import { createHash } from "node:crypto";
import { truncateJd } from "@/lib/ai/prompts/score";
import type { CareerConfig } from "@/lib/config/schemas/career";
import type { OutboundText } from "@/lib/outbound/outbound";
import { CareerStoreError } from "../contact/errors";
import { toOutbound } from "../ai/outbound";
import { documentView, factPool, type FactPool } from "../ai/view";
import type { CareerDocument } from "../schema/document";
import type { CareerProfile } from "../schema/profile";
import type { CareerPreferences } from "../schema/preferences";

export interface OutboundBlock { id: string; text: OutboundText }
export interface TailorOutbound { blocks: OutboundBlock[]; jd: string | null; jd_truncated: boolean; hash: string; pool: FactPool }
export const stripTailorTags = (text: string) => text.replace(/<\/?\s*(?:career_blocks|career_block|career_jd|career_source)\b[^>]*>/gi, "[tag removed]");
const outbound = (text: string) => toOutbound(stripTailorTags(text));

export function assembleOutbound(input: {
  doc: CareerDocument; profile: CareerProfile; preferences: CareerPreferences;
  job: { title: string; company: string; description: string | null } | null;
  mode: "tailor" | "shrink"; settings: CareerConfig;
}): TailorOutbound {
  const { doc, profile, preferences, job, settings } = input;
  if (doc.requirements.length > settings.tailor.max_requirements || doc.requirements.some((text) => text.length > settings.tailor.requirement_max_chars)) throw new CareerStoreError("limits");
  const blocks: OutboundBlock[] = [];
  const add = (id: string, value: unknown) => { blocks.push({ id, text: outbound(typeof value === "string" ? value : documentView(value)) }); };
  for (const key of ["headline", "summary", "experience", "projects", "education", "certifications", "languages", "skills", "approach", "custom_sections"] as const) {
    const value = doc[key];
    if (Array.isArray(value)) for (const entry of value) add(entry.id, entry);
    else if (value) add(key, value);
  }
  if (doc.letter) add("letter", doc.letter);
  const pool = factPool(profile, outbound);
  for (const key of ["headline", "summary", "experience", "projects", "education", "certifications", "languages", "skills", "approach", "custom_sections"] as const) {
    const value = profile[key];
    if (Array.isArray(value)) for (const entry of value) add(`facts_${entry.id}`, pool.entries[entry.id] ?? "");
    else if (value) add(`facts_${key}`, pool.entries[value.id] ?? "");
  }
  if (preferences.emphasis) add("emphasis", preferences.emphasis);
  if (preferences.tone) add("tone", preferences.tone);
  doc.requirements.forEach((requirement, index) => add(`requirement_${index}`, requirement));
  if (job) add("job", { title: job.title, company: job.company });
  const truncated = job?.description ? truncateJd(outbound(job.description), settings.tailor.jd_max_chars, settings.tailor.jd_head_share) : null;
  const jd = truncated ? outbound(truncated.text) : null;
  const canonical = JSON.stringify([blocks.map((block) => [block.id, block.text]), jd]);
  return { blocks, jd, jd_truncated: truncated?.truncated ?? false, hash: createHash("sha256").update(canonical).digest("hex"), pool };
}

/** All provider steps select from the exact same confirmed blocks, never from a previous model's prose. */
export function pickBlocks(outbound: Pick<TailorOutbound, "blocks">, ids: readonly string[]): OutboundBlock[] {
  const selected = new Set(ids);
  return outbound.blocks.filter((block) => selected.has(block.id));
}
export function previewOutbound(outbound: TailorOutbound) {
  return { blocks: outbound.blocks, jd: outbound.jd, jd_truncated: outbound.jd_truncated, hash: outbound.hash };
}
