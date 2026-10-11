/**
 * What the deal-breakers of preferences.yaml would veto among the jobs in the database (read only: nothing is written; the
 * filter step applies the rules). The same count as the preview on /me.
 *
 *   pnpm deal-breakers:check [--id <id>] [--limit N] [--json]
 *
 * For each rule: how many open jobs it vetoes, up to N of them (default 10) with the posting's words it matched, and the
 * time it took over all open jobs; a rule slower than `pipeline.yaml: filter.deal_breakers.rule_warn_ms` gets a warning.
 * Reads DATABASE_URL, JOB_RADAR_CONFIG_DIR and JOB_RADAR_PROFILE_DIR like the app.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import { parseConfigText, readConfigText } from "../src/lib/config";
import { closeDb, getDb } from "../src/lib/db";
import { currentMe } from "../src/lib/filter";
import { loadPipeline } from "../src/lib/market";
import { previewDealBreakers } from "../src/lib/profile/deal-breaker-preview";

const argsSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "--id must be a rule id").optional(),
  limit: z.coerce.number().int().min(0).max(10_000).default(10),
  json: z.boolean().default(false),
});

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { id: { type: "string" }, limit: { type: "string" }, json: { type: "boolean" } }, strict: true });
  const args = argsSchema.parse(values);
  const pipeline = loadPipeline();
  const preferences = parseConfigText("preferences", readConfigText("preferences"));
  const rules = preferences.deal_breakers;
  if (args.id !== undefined && !rules.some((rule) => rule.id === args.id)) throw new Error(`no deal-breaker with id "${args.id}" in preferences.yaml`);
  const warnMs = pipeline.filter.deal_breakers.rule_warn_ms;
  // every rule is counted (its position decides whether it is within max_rules); --id only narrows what is printed
  const all = await previewDealBreakers(getDb(), rules, { pipeline, me: currentMe(), sampleLimit: args.limit, explain: true });
  const preview = { ...all, rules: args.id === undefined ? all.rules : all.rules.filter((rule) => rule.id === args.id) };

  if (args.json) {
    console.log(JSON.stringify({ total: preview.total, ruleWarnMs: warnMs, rules: preview.rules.map((rule) => ({ ...rule, label: rules.find((r) => r.id === rule.id)?.label ?? rule.id, slow: rule.ms > warnMs })) }, null, 2));
  } else {
    if (rules.length === 0) console.log("preferences.yaml has no deal_breakers");
    console.log(`${preview.total} open job(s)`);
    for (const rule of preview.rules) {
      const label = rules.find((r) => r.id === rule.id)?.label ?? rule.id;
      const state = rule.status === "ok" ? "" : rule.status === "disabled" ? " (switched off)" : ` (does nothing: ${rule.status})`;
      console.log(`\n${rule.id} "${label}"${state}: vetoes ${rule.count}  [${rule.ms} ms]`);
      if (rule.ms > warnMs) console.log(`  ! slower than filter.deal_breakers.rule_warn_ms (${warnMs} ms): every filter run pays this`);
      for (const sample of rule.samples) {
        console.log(`  - job ${sample.jobId}: ${sample.title} · ${sample.company}`);
        if (sample.quote) console.log(`      "${sample.quote.replace(/\s+/g, " ")}"`);
      }
      if (rule.count > rule.samples.length) console.log(`  … ${rule.count - rule.samples.length} more`);
    }
  }
}

main()
  .then(() => closeDb())
  .catch(async (error: unknown) => {
    console.error(`deal-breakers:check: ${error instanceof Error ? error.message : String(error)}`);
    await closeDb();
    process.exitCode = 1;
  });
