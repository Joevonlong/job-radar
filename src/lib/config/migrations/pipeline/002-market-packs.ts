import type { ConfigMigration } from "../types";
import { deleteKey, insertBefore, mapAt, noteAbove, removeListItems, removeMapEntries, renameKey, setValue, valueAt } from "../edit";

import { V1_GERMAN_RULES, V1_LIST_VALUES, V1_MAP_VALUES } from "./v1-reference";

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** v1 `language.german_*` key -> the key of the pack's `requirement` block. */
const GERMAN_RULE_KEYS: ReadonlyArray<readonly [string, string]> = [
  ["german_level_max_distance", "level_max_distance"],
  ["german_level_rules", "level_rules"],
  ["german_optional_max_distance", "optional_max_distance"],
  ["german_optional_patterns", "optional_patterns"],
  ["german_list_languages", "list_languages"],
  ["german_ignore_patterns", "ignore_patterns"],
  ["german_preferred_section_patterns", "preferred_section_patterns"],
  ["german_required_section_patterns", "required_section_patterns"],
  ["german_required_patterns", "required_patterns"],
  ["german_section_max_distance", "section_max_distance"],
  ["german_not_required_patterns", "not_required_patterns"],
  ["german_sufficient_patterns", "sufficient_patterns"],
];

/** What v1 had in code (not in the file): the parts of the German rules that v2 keeps in the pack as well. */
const V1_GERMAN_CODE_RULES = {
  word_pattern: String.raw`\bgerman\b|\bdeutsch(?!land)(?!e[nrms]?\s+(?:bank|telekom|bahn|post|börse|boerse|lufthansa|welle))[\p{L}]*`,
  cefr_name_pattern: String.raw`german|deutsch(?!land)[\p{L}]*`,
  cefr_connectors: ["at", "level", "niveau", "auf", "dem", "skills?", "language", "ab", "of", "minimum", "mindestens", String.raw`min\.?`, String.raw`mind\.?`],
  cefr_level_words: ["level", "niveau"],
  cefr_prepositions: ["in", "of"],
  prompt_examples: "fluent / verhandlungssicher / native = C1; good German / gute Deutschkenntnisse = B2; basic German / Grundkenntnisse = A2",
} as const;

const MOVED_NOTE = "和市场包相同的条目已删除（现在由 config/packs/generic、config/packs/de 提供）；留下的是你自己加的";

/**
 * pipeline.yaml 1 -> 2: the market data moves into the packs. Entries equal to what v1 shipped are removed
 * (the packs supply them now); entries the user added stay and are united with the packs'. Changed German requirement
 * rules become `language.requirement` (a whole block that replaces the pack's).
 */
export const pipeline002: ConfigMigration = {
  from: 1,
  to: 2,
  description: "market packs: entries equal to the shipped German data removed (now in config/packs), own additions kept; fx_to_eur -> fx_pivot: EUR + fx_rates",
  migrate(doc) {
    let removed = 0;
    for (const [path, values] of Object.entries(V1_LIST_VALUES)) {
      const shipped = new Set(values);
      removed += removeListItems(doc, path.split("."), (value) => typeof value === "string" && shipped.has(value));
    }
    for (const [path, entries] of Object.entries(V1_MAP_VALUES)) {
      removed += removeMapEntries(doc, path.split("."), (key, value) => Object.hasOwn(entries, key) && same(value, entries[key]));
    }

    const language = mapAt(doc, ["language"]);
    if (language !== null) {
      const present = GERMAN_RULE_KEYS.filter(([from]) => valueAt(doc, ["language", from]) !== undefined);
      if (present.length > 0) {
        const unchanged = present.every(([from]) => same(valueAt(doc, ["language", from]), V1_GERMAN_RULES[from]));
        if (!unchanged) {
          const requirement: Record<string, unknown> = { ...V1_GERMAN_CODE_RULES };
          for (const [from, to] of GERMAN_RULE_KEYS) requirement[to] = valueAt(doc, ["language", from]) ?? V1_GERMAN_RULES[from];
          setValue(doc, ["language", "requirement"], requirement);
        }
        for (const [from] of present) deleteKey(doc, ["language"], from);
        removed += 1;
      }
    }
    if (removed > 0) noteAbove(doc, [], "company", MOVED_NOTE);

    // the rates were "EUR per unit": EUR becomes the pivot they are written in
    if (renameKey(doc, ["salary"], "fx_to_eur", "fx_rates")) {
      insertBefore(doc, ["salary"], "fx_rates", "fx_pivot", "EUR", "汇率表用哪种货币写（fx_rates 的值 = 1 单位外币值多少 fx_pivot）；任意两种货币经它换算");
    }
    // the market's currency is the default now (it was EUR)
    if (same(valueAt(doc, ["salary", "local_currencies"]), ["EUR"])) deleteKey(doc, ["salary"], "local_currencies");
  },
};
