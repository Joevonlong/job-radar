import { z } from "zod";

import { AI_PROVIDER_IDS, AI_PROVIDER_KIND, CODEX_REASONING_EFFORTS, type AiProviderIdChoice } from "../ai-options";

import { nonEmptyString, nonNegativeNumber } from "./common";

/** USD per 1M tokens, used for the cost estimates in `ai_usage` and the monthly API budget. */
const price = z.strictObject({
  input_per_mtok: nonNegativeNumber,
  output_per_mtok: nonNegativeNumber,
  /** Input tokens served from the cache; absent = priced like normal input. */
  cached_input_per_mtok: nonNegativeNumber.optional(),
  /** Input tokens written to the cache; absent = priced like normal input. */
  cache_write_per_mtok: nonNegativeNumber.optional(),
});

/** What a subscription model would cost at the vendor's API list price; statistics only, never the budget. */
const equivalentPrice = price.extend({ source: nonEmptyString });

const modelId = z.string().regex(/^\S+$/, "must be one word (no spaces)");

const catalogModel = z.strictObject({
  /** Passed to the CLI / API as the model name; unique within the provider. */
  id: modelId,
  /** Display name; the id is shown when absent. */
  label: nonEmptyString.optional(),
  /** Other names the vendor reports in replies (e.g. dated snapshots); also matched when pricing a call. */
  aliases: z.array(modelId).optional(),
  /** API providers only (and required there): USD per 1M tokens. */
  price: price.optional(),
  /** Subscription CLIs only: the API list price of the same model, for the "equivalent API cost" statistics. */
  equivalent_price: equivalentPrice.optional(),
  /** codex-cli only: the reasoning efforts this model supports; absent = all. */
  reasoning_efforts: z.array(z.enum(CODEX_REASONING_EFFORTS)).min(1).optional(),
  /** codex-cli only, at most one: the model the CLI uses when ai.yaml names none. */
  cli_default: z.boolean().optional(),
  /** true = retired: not offered in dropdowns; a model still selected is flagged. */
  deprecated: z.boolean().optional(),
  notes: nonEmptyString.optional(),
});

const catalogProvider = z.strictObject({
  label: nonEmptyString,
  docs_url: z.url().optional(),
  notes: nonEmptyString.optional(),
  models: z.array(catalogModel).min(1),
});

/** config/models.yaml: the model catalog. What is available lives here; what is chosen lives in ai.yaml. */
export const modelsSchema = z
  .strictObject({
    providers: z.strictObject({
      "claude-cli": catalogProvider,
      "codex-cli": catalogProvider,
      anthropic: catalogProvider,
      deepseek: catalogProvider,
      mimo: catalogProvider,
    }),
  })
  .superRefine((config, ctx) => {
    for (const provider of AI_PROVIDER_IDS) {
      const entry = config.providers[provider];
      let cliDefaults = 0;
      const ids = new Set(entry.models.map((m) => m.id));
      const seenIds = new Set<string>();
      const seenAliases = new Set<string>();
      entry.models.forEach((model, index) => {
        const at = ["providers", provider, "models", index];
        if (seenIds.has(model.id)) ctx.addIssue({ code: "custom", path: [...at, "id"], message: `duplicate model id "${model.id}"` });
        seenIds.add(model.id);
        model.aliases?.forEach((alias, j) => {
          if (ids.has(alias) || seenAliases.has(alias)) {
            ctx.addIssue({ code: "custom", path: [...at, "aliases", j], message: `alias "${alias}" clashes with another model id or alias` });
          }
          seenAliases.add(alias);
        });
        if (model.reasoning_efforts && new Set(model.reasoning_efforts).size !== model.reasoning_efforts.length) {
          ctx.addIssue({ code: "custom", path: [...at, "reasoning_efforts"], message: "must not contain duplicates" });
        }
        if (AI_PROVIDER_KIND[provider] === "api" && !model.price) {
          ctx.addIssue({ code: "custom", path: [...at, "price"], message: "API models need a price (cost estimate and monthly budget)" });
        }
        if (AI_PROVIDER_KIND[provider] === "cli" && model.price) {
          ctx.addIssue({ code: "custom", path: [...at, "price"], message: "subscription CLIs cost 0: remove price" });
        }
        if (AI_PROVIDER_KIND[provider] === "api" && model.equivalent_price) {
          ctx.addIssue({ code: "custom", path: [...at, "equivalent_price"], message: "API models are billed at their price: use price, not equivalent_price" });
        }
        if (provider !== "codex-cli") {
          if (model.reasoning_efforts) ctx.addIssue({ code: "custom", path: [...at, "reasoning_efforts"], message: "only allowed under codex-cli" });
          if (model.cli_default !== undefined) ctx.addIssue({ code: "custom", path: [...at, "cli_default"], message: "only allowed under codex-cli" });
        } else if (model.cli_default) {
          cliDefaults += 1;
          if (cliDefaults > 1) ctx.addIssue({ code: "custom", path: [...at, "cli_default"], message: "only one model can be the CLI default" });
        }
      });
    }
  });

export type ModelsConfig = z.infer<typeof modelsSchema>;
export type CatalogProviderEntry = ModelsConfig["providers"][AiProviderIdChoice];
export type CatalogModel = CatalogProviderEntry["models"][number];
