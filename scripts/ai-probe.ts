/**
 * Send one tiny structured request to each AI provider and report whether it works.
 *
 *   pnpm ai:probe [--provider claude-cli|codex-cli|anthropic|openai|openrouter|deepseek|mimo]... [--strong]
 *   pnpm ai:probe --provider <id> --model <model-id>     (try a model before selecting it)
 *
 * Prints per provider: availability ("not configured" when there is no key / CLI), latency, model and
 * token usage. Never prints keys. Exit code 1 when a provider that is configured fails, or when an
 * explicitly requested provider is not configured. This is the ONLY place that calls real CLIs/APIs
 * outside the cycle; the request is a few tokens. `.env` is loaded by the pnpm script.
 */
import { parseArgs } from "node:util";

import { z } from "zod";

import { loadModelCatalog } from "../src/lib/ai/catalog";
import { AiProviderError, sanitize } from "../src/lib/ai/errors";
import { createDefaultProviders } from "../src/lib/ai/providers";
import { CODEX_DEFAULT_MODEL } from "../src/lib/ai/providers/codex-cli";
import { codexVersionWarning, readCodexVersion } from "../src/lib/ai/providers/codex-version";
import { AI_PROVIDER_IDS, type AiProviderId } from "../src/lib/ai/types";
import { estimateCostUsd, estimateEquivalentUsd } from "../src/lib/ai/usage";
import { cliDefaultModel, findCatalogModel, loadConfig } from "../src/lib/config";

const probeSchema = z.object({ answer: z.string() });
const prompt = { system: "You answer in JSON only.", user: 'Reply with the JSON object {"answer": "ok"}.' };

function isProviderId(value: string): value is AiProviderId {
  return (AI_PROVIDER_IDS as readonly string[]).includes(value);
}

async function main(): Promise<number> {
  let values: { provider?: string[]; strong?: boolean; model?: string; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: { provider: { type: "string", multiple: true }, strong: { type: "boolean" }, model: { type: "string" }, help: { type: "boolean", short: "h" } },
      strict: true,
    }));
  } catch (error) {
    console.error(`ai:probe: ${error instanceof Error ? error.message : "bad arguments"}`);
    return 2;
  }
  if (values.help) {
    console.log(`Usage: pnpm ai:probe [--provider <id>]... [--strong] | --provider <id> --model <model-id>\nProviders: ${AI_PROVIDER_IDS.join(", ")}`);
    return 0;
  }
  const requested = values.provider ?? [];
  for (const id of requested) {
    if (!isProviderId(id)) {
      console.error(`ai:probe: unknown provider "${id}" (one of: ${AI_PROVIDER_IDS.join(", ")})`);
      return 2;
    }
  }
  const model = values.model?.trim() || undefined;
  if (values.model !== undefined && (!model || requested.length !== 1)) {
    console.error("ai:probe: --model needs a model id and exactly one --provider");
    return 2;
  }
  const config = loadConfig("ai");
  const catalog = loadModelCatalog();
  if (model && requested[0] && catalog && !findCatalogModel(catalog, requested[0] as AiProviderId, model)) {
    console.log(`note: "${model}" is not in models.yaml yet`);
  }
  const providers = createDefaultProviders(config).filter((p) => requested.length === 0 || (requested as string[]).includes(p.id));
  let failures = 0;
  if (providers.some((p) => p.id === "codex-cli")) {
    const installed = await readCodexVersion(config.providers.codex_cli.command);
    console.log(`codex-cli   installed version: ${installed ?? "unknown"} (minimum: ${config.providers.codex_cli.min_version})`);
    const warning = codexVersionWarning(installed, config.providers.codex_cli.min_version);
    if (warning) console.log(`codex-cli   WARNING: ${warning}`);
  }
  for (const provider of providers) {
    const availability = provider.availability();
    const label = provider.id.padEnd(11);
    if (!availability.available) {
      console.log(`${label} not configured (${availability.reason ?? "unavailable"})`);
      if (requested.length > 0) failures += 1;
      continue;
    }
    const started = Date.now();
    try {
      const result = await provider.run("score", prompt, probeSchema, { strong: values.strong ?? false, ...(model ? { model } : {}) });
      const { costUsd: cost } = estimateCostUsd(catalog, provider.id, result.model, result.usage);
      // codex without a configured model reports a placeholder: the catalog names its default
      const priceModel = result.model === CODEX_DEFAULT_MODEL && catalog ? (cliDefaultModel(catalog)?.id ?? result.model) : result.model;
      const equivalent = estimateEquivalentUsd(catalog, provider.id, priceModel, result.usage, { costUsd: cost, priced: catalog ? "exact" : "none" });
      const { usage } = result;
      const tokens = usage.reported === false
        ? "tokens=unreported"
        : `tokens in=${usage.tokensIn} out=${usage.tokensOut}  cached=${usage.cachedIn ?? "-"} cache_write=${usage.cacheWriteIn ?? "-"} reasoning=${usage.reasoningOut ?? "-"}`;
      const found = catalog ? findCatalogModel(catalog, provider.id, result.model) : null;
      const inCatalog = found ? (found.by === "id" ? "exact" : "alias") : "unknown";
      console.log(
        `${label} ok  ${Date.now() - started} ms  model=${result.model}  ${tokens}  cost≈$${cost.toFixed(6)}  equiv≈${equivalent === null ? "unknown" : `$${equivalent.toFixed(6)}`}  catalog=${inCatalog}  answer=${JSON.stringify(result.value.answer)}`,
      );
    } catch (error) {
      failures += 1;
      const detail = error instanceof AiProviderError ? `${error.kind}: ${error.message}` : sanitize(error instanceof Error ? error.message : "failed");
      console.log(`${label} FAILED  ${Date.now() - started} ms  ${detail}`);
    }
  }
  return failures > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`ai:probe: ${sanitize(error instanceof Error ? error.message : "failed")}`);
    process.exit(1);
  },
);
