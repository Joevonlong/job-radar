/**
 * Validate the config (both layers) and, when present, the profile files. Prints one line per file, saying where
 * each config is read from, and exits non-zero on any failure.
 *
 *   - every file a config is read from (the user file, else the shipped default) must pass its schema;
 *   - every shipped default must pass too (it is what a missing user file falls back to) and be at the code's
 *     config_version (the defaults ship migrated);
 *   - a user file older than the code is fine (it is migrated in memory) but listed: run pnpm config:migrate --write;
 *   - a user copy of a `shipped` file (models, pipeline) is listed as an override;
 *   - every market pack (shipped and user copies) must pass its schemas, and the market of preferences.yaml must resolve;
 *   - the visa and ghost job patterns of that market must compile; a phrase pattern without a prefilter word is only a warning;
 *   - the deal-breakers of preferences.yaml must keep to the limits of pipeline.yaml (a language gate in a market without a
 *     local-language step is only a warning: it does nothing).
 *
 *   - search.yaml's old `locations` and `remote_scope` name nothing preferences.yaml `places` lacks (only a warning: they are ignored);
 *   - the commented title_guard block of the shipped pipeline.yaml must equal the schema's defaults (a warning when the
 *     same-title limit is below the compatible limit or above the related-company limit);
 *   - the identity of the shipped defaults directory is printed (12 characters); a directory that cannot be identified (a
 *     symbolic link, an unsupported file name) is a failure.
 *
 * Per user file that is an overlay, the summary lines say how many keys it overrides and unsets; a pin equal to the shipped
 * value and an `!unset` of a key the shipped file does not have are listed as notes (neither is a failure).
 *
 * Usage: pnpm config:check   (honours JOB_RADAR_DEFAULTS_DIR / JOB_RADAR_CONFIG_DIR / JOB_RADAR_PROFILE_DIR)
 *
 * `pnpm config:check --effective [--json]` instead prints, per config file, where it is read from and the canonical hash
 * of its effective value (what the loader makes of it; key order, comments and config_version do not change it). Compare
 * the hashes before and after an upgrade: equal hashes mean the same effective config. Exits 1 when a file is invalid.
 *
 * `pnpm config:check --overrides [--json]` lists every key each overlay file overrides or unsets. A protected key never
 * shows a value; other values show only numbers, booleans and short plain strings; anything else shows its shape (`(list, 3 items)`). Reads only.
 */
import fs from "node:fs";
import path from "node:path";


import {
  ConfigError,
  CONFIG_NAMES,
  checkAiAgainstCatalog,
  configLayer,
  configRegistry,
  configSourcePath,
  displayConfigPath,
  getConfigDir,
  getDefaultConfigPath,
  getDefaultsDir,
  getProfileDir,
  getProfileExampleDir,
  getUserConfigPath,
  interestsRawWarnings,
  interestsWarnings,
  inspectModelsOverlay,
  LAYERED_CONFIG_NAMES,
  OVERLAID_CONFIG_NAMES,
  parseConfigText,
  parseConfigTextWithVersion,
  documentConfigVersion,
  fileLacksVersion,
  hasOverlayFormat,
  inspectOverlayFiles,
  isOverlayVersion,
  readConfigLayers,
  readConfigText,
  readEffectiveConfig,
  readEffectiveRaw,
  type ConfigName,
  type ConfigValue,
} from "../src/lib/config";
import { checkCommentedDefaults, TITLE_GUARD_BLOCK } from "../src/lib/config/commented-defaults";
import { effectiveConfigEntries } from "../src/lib/config/effective-report";
import { parseConfigYamlDocument } from "../src/lib/config/yaml-options";
import { titleGuardSchema } from "../src/lib/config/schemas/pipeline";
import { shippedConfigId, shortShippedConfigId } from "../src/lib/config/shipped-id";
import { dealBreakerLimitProblems, slowPatternProblems } from "../src/lib/filter/deal-breakers";
import { vmTimeBox } from "../src/lib/filter/time-box";
import { listPackIds, loadMarket, loadPipeline, packDirs, readPackDir } from "../src/lib/market";
import { homeCityAbroad, placeGeo, placesBeyondSearchEntries, searchEntriesOutsidePlaces } from "../src/lib/market/places";
import { compileGhostRules } from "../src/lib/ghost/rules";
import { compileVisaRules } from "../src/lib/visa/rules";

const rel = displayConfigPath;

if (process.argv.includes("--effective")) {
  const entries = effectiveConfigEntries();
  if (process.argv.includes("--json")) {
    const files = entries.map(({ name, file, layer, hash, error }) => ({ name, file: rel(file), layer, hash, error }));
    console.log(JSON.stringify({ files }, null, 2));
  } else {
    for (const entry of entries) {
      if (entry.layer === "missing") console.log(`- ${rel(entry.file)} (not present, skipped)`);
      else if (entry.error !== null) console.log(`✗ ${rel(entry.file)} (${entry.layer})\n    ${entry.error}`);
      else console.log(`✓ ${rel(entry.file)} (${entry.layer})  ${entry.hash ?? ""}`);
    }
  }
  process.exit(entries.some((entry) => entry.error !== null) ? 1 : 0);
}

if (process.argv.includes("--overrides")) {
  const files = inspectOverlayFiles();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ files: files.map(({ file, format, overrides, unsets, pins, invalidUnsets, entries }) => ({ file, format, overrides, unsets, pins, invalidUnsets, entries })) }, null, 2));
  } else {
    for (const file of files) {
      if (file.format !== "overlay") {
        console.log(`- ${file.file} (${file.format === "whole" ? "a whole file, not an overlay" : "cannot be read, see pnpm config:check"})`);
        continue;
      }
      console.log(`${file.file}  ${overlayCounts(file)}`);
      for (const entry of file.entries) {
        const note = entry.invalid ? "  (the shipped file has no such key)" : entry.pin ? "  (equals the shipped value)" : "";
        if (entry.kind === "unset") console.log(`  ${entry.path}: !unset${note}`);
        else console.log(`  ${entry.path}: ${entry.shown ?? "(protected key, value not shown)"}${note}`);
      }
    }
  }
  process.exit(0);
}

/** `3 overrides, 1 unset` */
function overlayCounts(file: { overrides: number; unsets: number }): string {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${plural(file.overrides, "override")}, ${plural(file.unsets, "unset")}`;
}

let failures = 0;
/** A user file at a version below the overlay format: it is read as the whole file, not laid over the shipped one. */
function isOverlayFile(name: ConfigName): boolean {
  if (!hasOverlayFormat(name)) return true; // no overlay format: "changes on the shipped file" still describes it
  const text = readConfigLayers(name).overlay;
  if (text === null) return true;
  try {
    return isOverlayVersion(name, documentConfigVersion(parseConfigYamlDocument(text, { unset: "overlay" })));
  } catch {
    return true;
  }
}

const pendingMigrations: string[] = [];

function report(label: string, run: () => string | void): void {
  try {
    const note = run();
    console.log(`✓ ${label}${note ? `  ${note}` : ""}`);
  } catch (err) {
    failures += 1;
    console.log(`✗ ${label}`);
    if (err instanceof ConfigError) {
      if (err.issues.length === 0) console.log(`    ${err.message.split("\n")[0]}`);
      for (const issue of err.issues) console.log(`    ${issue.path === "" ? "(root)" : issue.path}: ${issue.message}`);
    } else {
      console.log(`    ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

console.log(`defaults: ${rel(getDefaultsDir())}`);
console.log(`user:     ${rel(getConfigDir())}${fs.existsSync(getConfigDir()) ? "" : "  (does not exist yet: run pnpm config:init)"}`);
console.log(`profile:  ${rel(getProfileDir())}`);
// The identity of the shipped defaults (what the running processes report; `pnpm run doctor` compares them).
try {
  console.log(`shipped:  ${rel(getDefaultsDir())}  ${shortShippedConfigId(await shippedConfigId(getDefaultsDir()))}\n`);
} catch (err) {
  failures += 1;
  console.log(`✗ shipped:  ${rel(getDefaultsDir())}\n    ${err instanceof Error ? err.message : String(err)}\n`);
}

// What each config is read from.
for (const name of CONFIG_NAMES) {
  const entry = configRegistry[name];
  const layer = configLayer(name);
  const file = configSourcePath(name);
  if (entry.location === "profile" && layer === "missing") {
    console.log(`- ${rel(file)} (not present, skipped)`);
    continue;
  }
  const where = layer === "default" ? "(default)" : entry.location === "profile" ? "(profile)" : !isOverlayFile(name) ? "(user, whole file)" : "(user changes on the shipped file)";
  report(`${rel(file)} ${where}`, () => {
    const layers = readConfigLayers(name);
    const { migration } = parseConfigTextWithVersion(name, layers.overlay ?? layers.shipped ?? readConfigText(name), file, layers.shipped);
    if (migration.applied.length === 0) return;
    if (layer === "default") throw new Error(`the shipped default is at config_version ${migration.from}, the code expects ${migration.to}: ship it migrated`);
    pendingMigrations.push(rel(file));
    return `config_version ${migration.from} -> ${migration.to} applied in memory: run pnpm config:migrate --write`;
  });
}

// The shipped defaults are what a missing user file falls back to: they must be valid and current, even when overridden.
for (const name of LAYERED_CONFIG_NAMES) {
  const file = getDefaultConfigPath(name);
  if (file === null || configLayer(name) === "default") continue; // checked above
  if (!fs.existsSync(file)) {
    console.log(`- ${rel(file)} (no shipped default)`);
    continue;
  }
  const overlaid = (OVERLAID_CONFIG_NAMES as readonly ConfigName[]).includes(name);
  report(`${rel(file)} ${overlaid ? "(shipped base)" : "(default, not in use)"}`, () => {
    checkShippedVersion(name, file);
  });
}
function checkShippedVersion(name: ConfigName, file: string): void {
  const { migration } = parseConfigTextWithVersion(name, fs.readFileSync(file, "utf8"), file);
  if (migration.applied.length > 0) throw new Error(`the shipped default is at config_version ${migration.from}, the code expects ${migration.to}: ship it migrated`);
}

// The shipped profile templates must be valid too.
for (const name of CONFIG_NAMES.filter((n) => configRegistry[n].location === "profile")) {
  const file = path.join(getProfileExampleDir(), configRegistry[name].file);
  report(`${rel(file)} (profile template)`, () => {
    parseConfigText(name as ConfigName, fs.readFileSync(file, "utf8"), file);
  });
}

// A user file without config_version is read as a whole file: keys it lacks take the schema's defaults, not the shipped values.
for (const name of LAYERED_CONFIG_NAMES.filter(fileLacksVersion)) {
  console.log(`! ${rel(getUserConfigPath(name))} has no config_version: it is read as a whole file, so keys it lacks take the schema's defaults (a deploy's write step converts it; run pnpm config:plan --deploy)`);
}

// What each overlay file changes on the shipped file; a pin or an unset that does nothing is a note, not a failure.
for (const file of inspectOverlayFiles()) {
  if (file.format !== "overlay") continue;
  console.log(`· ${file.file}  ${overlayCounts(file)}`);
  const pins = file.entries.filter((entry) => entry.pin).map((entry) => entry.path);
  if (pins.length > 0) console.log(`! ${file.file} pins ${pins.length} key(s) at the shipped value (${pins.join(", ")}): they stop following product updates; remove one to follow the product, or keep it on purpose`);
  const invalid = file.entries.filter((entry) => entry.invalid).map((entry) => entry.path);
  if (invalid.length > 0) console.log(`! ${file.file} unsets ${invalid.length} key(s) the shipped file does not have (${invalid.join(", ")}): a typo, or a key a product update removed; the line does nothing, remove it`);
}

// models.yaml is an overlay: the user's file lists only what it adds or changes
{
  const overlay = inspectModelsOverlay();
  if (overlay !== null) {
    for (const warning of overlay.warnings) console.log(`! models.yaml ${warning.path.join(".")}: ${warning.message}`);
    if (overlay.redundant > 0) {
      console.log(`! ${rel(getUserConfigPath("models"))} lists ${overlay.redundant} of ${overlay.total} models exactly as the shipped models.yaml does: remove them to follow product updates (pnpm models:export --full writes the full catalog)`);
    }
  }
}

// interests.yaml can be valid and still unable to match a category
try {
  for (const warning of [...interestsWarnings(readEffectiveConfig("interests")), ...interestsRawWarnings(readEffectiveRaw("interests"))]) console.log(`! interests.yaml ${warning.path.join(".")}: ${warning.message}`);
} catch {
  // reported by the per-file lines above
}

// What ai.yaml selects must exist in the model catalog (models.yaml)
{
  const label = "ai.yaml ↔ models.yaml";
  let ai: ConfigValue<"ai"> | null = null;
  let catalog: ConfigValue<"models"> | null = null;
  try {
    ai = readEffectiveConfig("ai");
    catalog = readEffectiveConfig("models");
  } catch {
    // reported by the per-file lines above
  }
  if (!ai || !catalog) {
    console.log(`- ${label} (skipped: fix the files above first)`);
  } else {
    const issues = checkAiAgainstCatalog(ai, catalog);
    const errors = issues.filter((i) => i.severity === "error");
    if (errors.length > 0) {
      failures += 1;
      console.log(`✗ ${label}`);
      for (const issue of errors) console.log(`    ${issue.path.join(".")}: ${issue.message}`);
    } else {
      console.log(`✓ ${label}`);
    }
    for (const issue of issues.filter((i) => i.severity === "warning")) console.log(`    ! ${issue.path.join(".")}: ${issue.message}`);
  }
}

// Market packs: every shipped pack and every user copy (a copy replaces the shipped pack as a whole).
for (const id of listPackIds()) {
  const dirs = packDirs(id);
  for (const [dir, layer] of [[dirs.shipped, "shipped"], [dirs.user, "user"]] as const) {
    if (!fs.existsSync(path.join(dir, "pack.yaml"))) continue;
    report(`${rel(dir)}/ (market pack, ${layer === "user" ? "user copy: replaces the shipped pack" : "shipped"})`, () => {
      readPackDir(id, dir, layer);
    });
  }
}
report("preferences.yaml market", () => {
  const market = loadMarket();
  return `${market.packId}: ${market.country}, ${market.currency}, local language ${market.homeLanguage}${market.language === null ? " (no requirement rules: the language step is off)" : ""}`;
});

// The visa and ghost job patterns of the active market: valid, and each phrase contains a prefilter word (else it is skipped on texts
// without one)
{
  let pipeline: ReturnType<typeof loadPipeline> | null = null;
  try {
    pipeline = loadPipeline();
  } catch {
    // reported by the lines above
  }
  if (pipeline === null) {
    console.log("- visa patterns (skipped: fix the files above first)");
    console.log("- ghost job patterns (skipped: fix the files above first)");
  } else {
    const loaded = pipeline;
    let violations: string[] = [];
    report("visa patterns of the market packs", () => {
      violations = compileVisaRules(loaded).prefilterViolations;
    });
    for (const where of violations) console.log(`    ! ${where}: has no word of visa.prefilter, so it is skipped on a text without one (add a prefilter word)`);
    let ghostViolations: string[] = [];
    report("ghost job patterns of the market packs", () => {
      ghostViolations = compileGhostRules(loaded).prefilterViolations;
    });
    for (const where of ghostViolations) console.log(`    ! ${where}: has no word of ghost.prefilter, so it is skipped on a text without one (add a prefilter word)`);
  }
}

// The commented title_guard block of the shipped pipeline.yaml says what applies while it stays commented out: it must not drift.
{
  const file = getDefaultConfigPath("pipeline");
  if (file !== null && fs.existsSync(file)) {
    report("title_guard commented defaults", () => {
      const checked = checkCommentedDefaults(fs.readFileSync(file, "utf8"), TITLE_GUARD_BLOCK, "title_guard", titleGuardSchema);
      if (!checked.ok) throw new Error(`title_guard commented defaults: ${checked.reason} (${rel(file)}, line ${checked.line})`);
    });
  }
  try {
    const { dedupe } = loadPipeline();
    const sameMax = dedupe.title_guard.same_title_max_distance;
    if (sameMax < dedupe.simhash_max_distance) console.log(`! dedupe.title_guard.same_title_max_distance (${sameMax}) is below dedupe.simhash_max_distance (${dedupe.simhash_max_distance}): titles that only look alike would merge more easily than equal ones`);
    if (sameMax > dedupe.cross_company_simhash_max_distance) console.log(`! dedupe.title_guard.same_title_max_distance (${sameMax}) is above dedupe.cross_company_simhash_max_distance (${dedupe.cross_company_simhash_max_distance}): the same company would be looser than related company names`);
  } catch {
    // reported by the lines above
  }
}

// search.yaml's old location keys are ignored: warn about what they name that the location settings lack; and about a home city abroad
if (fs.existsSync(path.join(getProfileDir(), "preferences.yaml"))) {
  try {
    const preferences = parseConfigText("preferences", readConfigText("preferences"));
    const pipeline = loadPipeline();
    const added = placesBeyondSearchEntries(readEffectiveConfig("search"), preferences, placeGeo(pipeline), { country: pipeline.market.country, countryName: pipeline.market.countryName });
    if (added.length > 0) console.log(`! preferences.yaml: ${added.join(", ")} searched now, though search.yaml's old locations, remote_scope did not list them`);
    const names = searchEntriesOutsidePlaces(readEffectiveConfig("search"), preferences, placeGeo(pipeline), { country: pipeline.market.country, countryName: pipeline.market.countryName });
    if (names.length > 0) console.log(`! search.yaml locations, remote_scope: ${names.join(", ")} not in preferences.yaml places; these keys are ignored, so they are not searched`);
    const abroad = homeCityAbroad(preferences.home_city, placeGeo(pipeline), pipeline.market.country);
    if (abroad !== null) console.log(`! preferences.yaml home_city: ${preferences.home_city} is in ${abroad.name}, not in the home country ${pipeline.market.countryName}; on-site jobs are looked for there inside ${pipeline.market.countryName}. Set a city in ${pipeline.market.countryName} as home_city and list ${preferences.home_city} under places`);
  } catch {
    // an unreadable file is reported by its own check above
  }
}

// preferences.yaml deal_breakers: the limits of pipeline.yaml filter.deal_breakers, and a language gate needs the language step
// (nothing to check before the profile exists)
if (fs.existsSync(path.join(getProfileDir(), "preferences.yaml"))) {
  const label = "preferences.yaml deal_breakers ↔ pipeline.yaml";
  let rules: ConfigValue<"preferences">["deal_breakers"] | null = null;
  let pipeline: ReturnType<typeof loadPipeline> | null = null;
  try {
    rules = parseConfigText("preferences", readConfigText("preferences")).deal_breakers;
    pipeline = loadPipeline();
  } catch {
    // reported by the lines above
  }
  if (rules === null || pipeline === null) {
    console.log(`- ${label} (skipped: fix the files above first)`);
  } else if (rules.length > 0) {
    const problems = dealBreakerLimitProblems(rules, pipeline.filter.deal_breakers);
    const slow = slowPatternProblems(rules, pipeline.filter.deal_breakers, vmTimeBox);
    if (problems.length > 0 || slow.length > 0) {
      failures += 1;
      console.log(`✗ ${label}`);
      for (const problem of problems) {
        const where = ["deal_breakers", ...problem.path].join(".");
        console.log(`    ${where}: ${problem.kind === "too_many_rules" ? `more than ${problem.max} rules (filter.deal_breakers.max_rules)` : `longer than ${problem.max} characters (filter.deal_breakers.max_pattern_chars)`}`);
      }
      for (const problem of slow) {
        console.log(`    deal_breakers.${problem.path.join(".")}: too slow on a long test text (over ${pipeline.filter.deal_breakers.match_ms} ms, filter.deal_breakers.match_ms)`);
      }
    } else {
      console.log(`✓ ${label}  ${rules.length} rule(s)`);
    }
    if (pipeline.market.language === null) {
      rules.forEach((rule, index) => {
        if (rule.type === "language_gate" && rule.enabled) console.log(`    ! deal_breakers.${index} (${rule.id}): a language gate does nothing, the market has no local-language step`);
      });
    }
    if (rules.some((rule) => rule.type === "visa_not_offered" && rule.enabled)) {
      let needs: boolean | null = null;
      try {
        needs = parseConfigText("me", readConfigText("me")).needs_visa_sponsorship;
      } catch {
        // me.yaml is reported above; the filter then leaves the visa rule out
      }
      if (needs !== true) {
        rules.forEach((rule, index) => {
          if (rule.type === "visa_not_offered" && rule.enabled) {
            console.log(`    ! deal_breakers.${index} (${rule.id}): a visa rule does nothing, ${needs === false ? "me.yaml needs_visa_sponsorship is false" : "me.yaml cannot be read"}`);
          }
        });
      }
    }
  }
}

if (failures > 0) {
  console.log(`\n${failures} config file(s) invalid`);
  process.exit(1);
}
console.log(pendingMigrations.length > 0 ? `\nAll config files valid; ${pendingMigrations.length} to migrate (pnpm config:migrate --write)` : "\nAll config files valid");
