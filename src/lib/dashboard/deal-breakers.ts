import type { DealBreakerNotice } from "@/components/jobs/filter-notice";
import { parseConfigText, readConfigText, type MeConfig, type PreferencesConfig } from "@/lib/config";
import type { GermanLevel } from "@/lib/domain/types";
import { explainDealBreaker, type DealBreakerExplanation } from "@/lib/filter/deal-breakers";
import { vmTimeBox } from "@/lib/filter/time-box";
import { dealBreakerIds } from "@/lib/filter/reasons";
import { loadPipeline } from "@/lib/market";
import { visaRulesFor } from "@/lib/visa/rules";

/*
 * The profile files are read from disk on each call, not from the config cache: the user may edit deal_breakers or their
 * level by hand, the runner's filter step applies such an edit on its next run, and the web process caches only what it
 * wrote itself. The names and explanations must follow the file the filter read.
 */
function preferencesOrNull(): PreferencesConfig | null {
  try {
    return parseConfigText("preferences", readConfigText("preferences"));
  } catch {
    return null;
  }
}

function meOrNull(): MeConfig | null {
  try {
    return parseConfigText("me", readConfigText("me"));
  } catch {
    return null;
  }
}

/** The names of the user's deal-breakers by id, as preferences.yaml says now (empty when it cannot be read: the reasons then show ids). */
export function loadDealBreakerLabels(): Record<string, string> {
  const preferences = preferencesOrNull();
  return Object.fromEntries((preferences?.deal_breakers ?? []).map((rule) => [rule.id, rule.label]));
}

/**
 * The deal-breakers a job's filter reasons name, with why each one applies to the job now (the quote is computed here, never
 * stored). A rule deleted or changed since the filter ran has no explanation; its reason still shows (by id when deleted).
 * Undefined when the reasons name none.
 */
export function loadDealBreakerNotice(job: { title: string; description: string | null; germanLevelRule: GermanLevel; company?: { nameNorm: string } }, reasons: readonly string[]): DealBreakerNotice | undefined {
  const ids = dealBreakerIds(reasons);
  if (ids.length === 0) return undefined;
  const preferences = preferencesOrNull();
  const rules = preferences?.deal_breakers ?? [];
  const labels = Object.fromEntries(rules.map((rule) => [rule.id, rule.label]));
  const explanations: DealBreakerExplanation[] = [];
  try {
    const pipeline = loadPipeline();
    const context = { language: pipeline.market.language?.code ?? null, me: meOrNull(), limits: pipeline.filter.deal_breakers, visa: visaRulesFor(pipeline) };
    const subject = { title: job.title, description: job.description, germanLevel: job.germanLevelRule, companyNameNorm: job.company?.nameNorm ?? null };
    for (const id of ids) {
      const rule = rules.find((r) => r.id === id);
      // each pattern run is cut off at filter.deal_breakers.match_ms: a slow rule shows its name without the quote
      const explanation = rule ? explainDealBreaker(subject, rule, context, pipeline, vmTimeBox) : null;
      if (explanation) explanations.push(explanation);
    }
  } catch {
    // the pipeline settings cannot be read: the names alone
  }
  return { labels, explanations };
}
