/** Only match permission releases judgements; profile inputs are used for checks and never copied into the output. */
import type { z } from "zod";

import { floorCheck } from "@/lib/dashboard/floor-check";
import { germanCheck } from "@/lib/dashboard/german-check";
import { buildSkillAliasMap, matchSkills, profileSkillKeys } from "@/lib/dashboard/skills";
import type { McpContext } from "@/lib/mcp/context";
import { matchBlockDto } from "@/lib/mcp/dto/job-match";
import { isoOrNull } from "@/lib/mcp/dto/shared";
import type { ReasonSource } from "@/lib/scoring/evidence";
import { buildVisaCheckView } from "@/lib/visa/view";

import { jobBlockSettings } from "./settings";
import type { JobBlockSource } from "./source";

export async function loadMatch(_ctx: McpContext, source: JobBlockSource): Promise<z.infer<typeof matchBlockDto>> {
  const { detail, clean } = source;
  const score = detail.score;
  if (score === null) return null;
  const settings = jobBlockSettings();
  const aliases = buildSkillAliasMap(settings.skillAliases());
  const skills = matchSkills(detail.skills, profileSkillKeys(settings.skills(), aliases), aliases);
  const german = germanCheck(detail.germanLevelRequired, settings.germanLabel());
  const floor = floorCheck(detail.salary, settings.salaryFloor(), settings.baseCurrency() ?? "");
  const visa = settings.visaEnabled() ? buildVisaCheckView(detail.visa, settings.needsVisaSponsorship()) : null;
  const notice = settings.dealBreakers(detail, score.filterReasons);
  const written = source.strict.ok;
  const reason = (text: string, evidence: ReasonSource | undefined) => ({ text: clean(text), basis: evidence?.basis ?? null, quote: evidence?.quote === null || evidence?.quote === undefined ? null : source.quote(evidence.quote, evidence.offset), offset: evidence?.offset ?? null });
  return {
    available: written,
    reason: source.strict.ok ? null : source.strict.reason,
    summaries: !written ? {} : Object.fromEntries(Object.entries(score.summaries).map(([language, text]) => [clean(language), clean(text)])),
    output_lang: score.outputLang === null ? null : clean(score.outputLang),
    ai_score: score.aiScore,
    german_penalty: score.germanPenalty,
    scored_at: isoOrNull(score.scoredAt),
    stale: score.stale,
    fit_reasons: !written ? [] : score.fitReasons.map((text, index) => reason(text, score.reasonEvidence?.fit[index])),
    gaps: !written ? [] : score.gaps.map((text, index) => reason(text, score.reasonEvidence?.gaps[index])),
    filter: { result: score.filterResult, reasons: score.filterReasons.map(clean) },
    deal_breakers: (notice?.explanations ?? []).map((entry) => ({ id: clean(entry.id), type: entry.type, field: entry.field, quote: entry.quote === null ? null : entry.field === "description" ? source.quote(entry.quote, entry.offset) : clean(entry.quote), offset: entry.offset, required: entry.required ?? null, visa_kind: entry.visaKind ?? null })),
    visa: visa ? { state: visa.state, kind: visa.kind, checked_at: isoOrNull(detail.visa?.checkedAt ?? null), match: visa.tone === "good" ? "supports" : visa.tone === "bad" ? "refuses" : "neutral", evidence: visa.evidence.map((entry) => ({ status: entry.status, kind: entry.kind, quote: source.quote(entry.quote, entry.offset), offset: entry.offset })) } : null,
    checks: { skills: skills.map((entry) => ({ name: clean(entry.name), have: entry.have })), german: { state: german.state, required: german.required }, salary_floor: { state: floor.state, figure: floor.top, currency: clean(floor.currency), approx: floor.approx } },
  };
}
