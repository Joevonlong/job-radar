import { createHash } from "node:crypto";

import type { TrapsConfig } from "@/lib/config/schemas/traps";

/**
 * Bump when the scanners change in a way traps.yaml does not show (a new technique, a channel that now gives its HTML):
 * every job is scanned again by the next cycles.
 */
export const TRAP_RULES_VERSION = 1;

/**
 * Hash of everything the rule results depend on besides the job: the scanner version and the rule settings of traps.yaml.
 * The switches that only decide what happens with the results (`enabled`, the AI check mode and limits, the markers, the cycle
 * limit, the doctor threshold) are left out, so changing them never rescans.
 */
export function rulesFingerprint(settings: TrapsConfig): string {
  const relevant = {
    version: TRAP_RULES_VERSION,
    min_hidden_chars: settings.scan.min_hidden_chars,
    quote_max_chars: settings.scan.quote_max_chars,
    max_findings_per_job: settings.scan.max_findings_per_job,
    hidden: settings.hidden,
    invisible_unicode: settings.invisible_unicode,
    instruction_languages: settings.instruction_languages,
    instructions: settings.instructions,
    triggers: settings.ai_check.triggers,
  };
  return createHash("sha256").update(JSON.stringify(relevant)).digest("hex").slice(0, 32);
}

/** md5 of a JD as the database computes it (`md5(coalesce(description, ''))`). */
export function descriptionMd5(description: string | null): string {
  return createHash("md5").update(description ?? "", "utf8").digest("hex");
}
