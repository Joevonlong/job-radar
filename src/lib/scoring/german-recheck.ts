import { scoreTransaction } from "@/lib/db/repos/current-scores";
import type { AiConfig, MeConfig, PipelineConfig } from "@/lib/config";
import type { Db } from "@/lib/db/client";
import { asGermanLevel } from "@/lib/db/queries/parse";
import { listGermanRecheckRows, updateGermanOutcome } from "@/lib/db/repos/scores";

import { languagePenalty, resolveGermanLevel } from "./german";
import { computeRankValue, finalMatchScore } from "./rank";

export interface GermanRecheckResult {
  checked: number;
  updated: number;
}

/**
 * Settle the German level of every current score again from the job's rule level, the AI's stored
 * reading and the profile, and fix the deduction, match score and rank value when the outcome moved.
 * No AI call: the deduction is code. It makes an improvement of the pipeline's German rules
 * reach scores that were made before it (a "preferred" German that cost 20 points, a "verhandlungssicher"
 * the old rule read as optional) without re-scoring.
 */
export async function recheckGerman(
  db: Db,
  input: { me: Pick<MeConfig, "languages">; penalties: AiConfig["scoring"]["language_penalty"]; bonusCap: number; pipeline: PipelineConfig },
): Promise<GermanRecheckResult> {
  const language = input.pipeline.market.language?.code ?? null;
  const rows = await listGermanRecheckRows(db);
  const result: GermanRecheckResult = { checked: rows.length, updated: 0 };
  for (const row of rows) {
    const resolved = resolveGermanLevel({ rule: asGermanLevel(row.rule), ai: asGermanLevel(row.germanLevelAi), jdText: row.description ?? "", pipeline: input.pipeline });
    const penalty = languagePenalty(resolved.level, input.me, input.penalties, language);
    if (resolved.level === row.germanLevel && resolved.source === row.germanLevelSource && penalty === row.germanPenalty) continue;
    const score = finalMatchScore(row.aiScore, penalty);
    await scoreTransaction(db, (tx) => updateGermanOutcome(tx, row.id, {
      germanLevel: resolved.level,
      germanLevelSource: resolved.source,
      germanPenalty: penalty,
      score,
      rankValue: computeRankValue(score, row.signalBonus, input.bonusCap),
    }));
    result.updated += 1;
  }
  return result;
}
