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
 *   - the identity of the shipped defaults directory is printed (12 characters); a directory that cannot be identified (a
 *     symbolic link, an unsupported file name) is a failure.
 *
 * Usage: pnpm config:check   (honours JOB_RADAR_DEFAULTS_DIR / JOB_RADAR_CONFIG_DIR / JOB_RADAR_PROFILE_DIR)
 *
 * `pnpm config:check --effective [--json]` instead prints, per config file, where it is read from and the canonical hash
 * of its effective value (what the loader makes of it; key order, comments and config_version do not change it). Compare
 * the hashes before and after an upgrade: equal hashes mean the same effective config. Exits 1 when a file is invalid.
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
  interestsWarnings,
  LAYERED_CONFIG_NAMES,
  parseConfigText,
  parseConfigTextWithVersion,
  readConfigText,
  type ConfigName,
  type ConfigValue,
} from "../src/lib/config";
import { effectiveConfigEntries } from "../src/lib/config/effective-report";
import { shippedConfigId, shortShippedConfigId } from "../src/lib/config/shipped-id";
import { dealBreakerLimitProblems, slowPatternProblems } from "../src/lib/filter/deal-breakers";
import { vmTimeBox } from "../src/lib/filter/time-box";
import { listPackIds, loadMarket, loadPipeline, packDirs, readPackDir } from "../src/lib/market";
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

let failures = 0;
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
  const where = layer === "default" ? "(default)" : entry.location === "profile" ? "(profile)" : entry.kind === "shipped" ? "(user override of a shipped file)" : "(user)";
  report(`${rel(file)} ${where}`, () => {
    const { migration } = parseConfigTextWithVersion(name, readConfigText(name), file);
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
  report(`${rel(file)} (default, not in use)`, () => {
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

// Overrides of shipped files: the product's updates of them no longer apply.
for (const name of LAYERED_CONFIG_NAMES.filter((n) => configRegistry[n].kind === "shipped" && configLayer(n) === "user")) {
  console.log(`! ${rel(getUserConfigPath(name))} replaces the shipped ${configRegistry[name].file}: product updates of that file no longer apply (delete it to follow them)`);
}

// interests.yaml can be valid and still unable to match a category
try {
  for (const warning of interestsWarnings(parseConfigText("interests", readConfigText("interests")))) console.log(`! interests.yaml ${warning.path.join(".")}: ${warning.message}`);
} catch {
  // reported by the per-file lines above
}

// What ai.yaml selects must exist in the model catalog (models.yaml)
{
  const label = "ai.yaml ↔ models.yaml";
  let ai: ConfigValue<"ai"> | null = null;
  let catalog: ConfigValue<"models"> | null = null;
  try {
    ai = parseConfigText("ai", readConfigText("ai"));
    catalog = parseConfigText("models", readConfigText("models"));
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
