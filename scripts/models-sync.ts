/**
 * Refresh the selectable models of a multi-model provider from the service, and add the ones you pick to your own list.
 *
 *   pnpm models:sync --provider openrouter [--filter <word>] [--dry-run]
 *   pnpm models:sync --provider openrouter --add <id> [<id>...] [--allow-unverified]
 *   pnpm models:sync --provider openrouter --update-prices [--filter <word>]
 *
 * Without --add / --update-prices it only prints the table: id, name, price in USD per 1M tokens (input / output / cache read),
 * context length, whether the service says it takes JSON mode, whether it is in the catalog, a changed price, a retirement date.
 * --add and --update-prices write the models you chose into your models.yaml (data/config/models.yaml; the shipped catalog is
 * untouched); --dry-run shows what they would write and writes nothing. A model that is no longer listed is only flagged, never
 * removed. A model whose JSON support the service does not state is listed as "unverified" and is only added with --allow-unverified.
 * A refresh only happens when you run this: nothing refreshes the list by itself.
 */
import { parseArgs } from "node:util";

import { ConfigError } from "../src/lib/config";
import { AiProviderError, sanitize } from "../src/lib/ai/errors";
import { buildSyncResult, catalogEntryFor, isModelSyncProvider, listProviderModels, MODEL_SYNC_PROVIDERS, type SyncRow } from "../src/lib/ai/model-sync";
import { findCatalogModel, loadConfig, type CatalogModel } from "../src/lib/config";
import { writeModelsOverlay } from "../src/lib/config/models-overlay-write";

const USAGE = `Usage: pnpm models:sync --provider ${MODEL_SYNC_PROVIDERS.join("|")} [--filter <word>] [--add <id>...] [--allow-unverified] [--update-prices] [--dry-run]`;

const money = (value: number | undefined): string => (value === undefined ? "-" : String(Number(value.toPrecision(4))));

function line(row: SyncRow): string {
  const price = row.price ? `${money(row.price.input_per_mtok)} / ${money(row.price.output_per_mtok)} / ${money(row.price.cached_input_per_mtok)}` : "no price";
  const flags = [
    row.inCatalog ? "in catalog" : row.addable ? "can add" : row.addableUnverified ? "unverified" : row.textChat ? "cannot add" : "not a chat model",
    row.priceWas ? `price changed (was ${money(row.priceWas.input_per_mtok)} / ${money(row.priceWas.output_per_mtok)})` : "",
    row.expiresOn ? `retires ${row.expiresOn}` : "",
  ].filter((flag) => flag !== "");
  return [row.id.padEnd(46), price.padEnd(22), (row.contextLength === null ? "-" : String(row.contextLength)).padStart(9), row.json.padEnd(10), flags.join("; ")].join("  ");
}

/** Why a row cannot be added, or null when it can (`allowUnverified` lets an unverified one through). */
function refusal(row: SyncRow, allowUnverified: boolean, today: string): string | null {
  if (row.addable || (allowUnverified && row.addableUnverified)) return null;
  if (!row.textChat) return "not a text chat model";
  if (row.price === null) return "the service lists no usable price";
  if (row.expiresOn !== null && row.expiresOn <= today) return `retired on ${row.expiresOn}`;
  if (row.json === "no") return "the service says it does not take JSON mode";
  return "JSON mode is not stated by the service (add --allow-unverified to add it anyway)";
}

async function main(): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: { provider: { type: "string" }; filter: { type: "string" }; add: { type: "string"; multiple: true }; "allow-unverified": { type: "boolean" }; "update-prices": { type: "boolean" }; "dry-run": { type: "boolean" }; help: { type: "boolean"; short: "h" } }; allowPositionals: true }>>;
  try {
    parsed = parseArgs({
      options: { provider: { type: "string" }, filter: { type: "string" }, add: { type: "string", multiple: true }, "allow-unverified": { type: "boolean" }, "update-prices": { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`models:sync: ${error instanceof Error ? error.message : "bad arguments"}\n${USAGE}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const provider = values.provider ?? "";
  if (!isModelSyncProvider(provider)) {
    console.error(`models:sync: --provider must be one of ${MODEL_SYNC_PROVIDERS.join(", ")}\n${USAGE}`);
    return 2;
  }
  const add = [...(values.add ?? []), ...positionals].map((id) => id.trim()).filter((id) => id !== "");
  if (positionals.length > 0 && (values.add ?? []).length === 0) {
    console.error("models:sync: ids go after --add\n" + USAGE);
    return 2;
  }
  const updatePrices = values["update-prices"] === true;
  const allowUnverified = values["allow-unverified"] === true;
  const dryRun = values["dry-run"] === true;
  if (allowUnverified && add.length === 0) {
    console.error("models:sync: --allow-unverified goes with --add");
    return 2;
  }

  const ai = loadConfig("ai");
  const catalog = loadConfig("models");
  let result;
  try {
    const listed = await listProviderModels(provider, ai);
    result = buildSyncResult(provider, listed, catalog, { filter: values.filter, maxRows: Number.POSITIVE_INFINITY });
  } catch (error) {
    const kind = error instanceof AiProviderError ? error.kind : "error";
    console.error(`models:sync: could not read the ${provider} model list (${kind}): ${sanitize(error instanceof Error ? error.message : "")}`);
    return 1;
  }

  console.log(`${provider}: ${result.listed} models listed${values.filter ? `, ${result.matched} match "${values.filter}"` : ""} (price: USD per 1M tokens, input / output / cache read)`);
  console.log(`${"id".padEnd(46)}  ${"price".padEnd(22)}  ${"context".padStart(9)}  ${"JSON".padEnd(10)}  status`);
  for (const row of result.rows) console.log(line(row));
  if (result.gone.length > 0) console.log(`\nIn your catalog but no longer listed by ${provider} (flagged only, not removed): ${result.gone.join(", ")}`);

  const date = new Date(result.fetchedAt).toISOString().slice(0, 10);
  const byId = new Map(result.rows.map((row) => [row.id, row]));
  const entries: CatalogModel[] = [];
  let problems = 0;
  for (const id of add) {
    const row = byId.get(id);
    if (row === undefined) {
      console.error(`models:sync: "${id}" is not in the list${values.filter ? " (the filter hides it?)" : ""}`);
      problems += 1;
    } else if (row.inCatalog) {
      console.log(`"${id}" is already in the catalog${row.priceWas ? " (use --update-prices to take the new price)" : ""}`);
    } else {
      const why = refusal(row, allowUnverified, date);
      if (why !== null) {
        console.error(`models:sync: "${id}" cannot be added: ${why}`);
        problems += 1;
      } else {
        entries.push(catalogEntryFor(row, null, date, row.json !== "yes"));
      }
    }
  }
  if (updatePrices) {
    for (const row of result.rows) {
      const existing = row.priceWas ? (findCatalogModel(catalog, provider, row.id)?.model ?? null) : null;
      if (row.priceWas && existing && row.price) entries.push(catalogEntryFor(row, existing, date));
    }
  }
  if (problems > 0) return 1;
  if (entries.length === 0) {
    if (add.length > 0 || updatePrices) console.log("Nothing to write.");
    return 0;
  }
  console.log(`\n${dryRun ? "Would write" : "Writing"} ${entries.length} model${entries.length === 1 ? "" : "s"} to your models.yaml: ${entries.map((entry) => entry.id).join(", ")}`);
  if (dryRun) return 0;
  try {
    await writeModelsOverlay(provider, entries);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`models:sync: ${error.message}`);
      return 1;
    }
    throw error;
  }
  console.log("Done. Select the model in /settings (AI tab) or in ai.yaml.");
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(`models:sync: ${error instanceof Error ? error.message : "failed"}`);
    process.exit(1);
  },
);
