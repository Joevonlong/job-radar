/**
 * How the overlay merge treats each record (`z.record` / `z.partialRecord`) of the layered config schemas. A mapping
 * the schema declares key by key is always merged key by key, and a list is always replaced as a whole; a record could
 * mean either, so every record is registered here with one of:
 *
 * - `entries`: a map of independent entries (a glossary, provider → model). Merged entry by entry: the user adds,
 *   changes or `!unset`s single entries and the other shipped entries keep following the product;
 * - `whole`: a set that only makes sense as a whole (`search.keyword_groups`). A user value replaces the shipped one;
 * - `opaque`: the values have no known shape (`z.unknown()`, a provider's raw input template). Replaced as a whole;
 * - `in-array`: the record sits inside a list item, so it follows the list (lists are replaced as a whole).
 *
 * `tests/config/record-coverage.test.ts` walks every layered schema and fails on a record that is not registered here
 * (or a rule that matches no record). Paths: dotted keys, `*` = any single key, `[]` = the items of a list.
 */
import type { ConfigName } from "./registry";

export type RecordKind = "entries" | "whole" | "opaque" | "in-array";

export interface RecordRule {
  /** Dotted path of the record: `*` stands for any one key, `[]` for the items of a list. */
  path: string;
  kind: RecordKind;
}

export const OVERLAY_RECORD_RULES: Readonly<Partial<Record<ConfigName, readonly RecordRule[]>>> = {
  ai: [
    { path: "tasks.*.models", kind: "entries" },
    { path: "providers.codex_cli.reasoning_effort_by_task", kind: "entries" },
    { path: "providers.codex_cli.config_overrides", kind: "entries" },
    { path: "scoring.language_penalty", kind: "entries" },
    { path: "translation.glossary", kind: "entries" },
  ],
  channels: [
    { path: "linkedin.apify.input_template", kind: "opaque" },
    { path: "linkedin.apify.remote_input", kind: "opaque" },
    { path: "linkedin.monid.input_template", kind: "opaque" },
    { path: "linkedin.monid.remote_input", kind: "opaque" },
  ],
  pipeline: [
    { path: "company.aliases", kind: "entries" },
    { path: "salary.fx_rates", kind: "entries" },
    // each entry's value (a list) is replaced as a whole; the market packs then add theirs (union)
    { path: "filter.city_aliases", kind: "entries" },
    { path: "filter.metro_areas", kind: "entries" },
    { path: "filter.metro_regions", kind: "entries" },
  ],
  search: [{ path: "keyword_groups", kind: "whole" }],
  setup: [{ path: "steps", kind: "entries" }],
  interests: [
    { path: "signals.categories.[].amount.rough_fx", kind: "in-array" },
    { path: "signals.retired_categories.[].amount.rough_fx", kind: "in-array" },
  ],
  signalPresets: [
    { path: "presets.[].keywords", kind: "in-array" },
    { path: "presets.[].patterns", kind: "in-array" },
    { path: "presets.[].exclude", kind: "in-array" },
  ],
};

/** A key path (the merge never descends into lists, so it has no `[]`). */
export type KeyPath = readonly string[];

function matches(pattern: readonly string[], path: KeyPath): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((segment, index) => segment === "*" || segment === path[index]);
}

/** The registered kind of the record at `path` of a config, or null when no record is registered there. */
export function recordKindAt(name: ConfigName, path: KeyPath): RecordKind | null {
  for (const rule of OVERLAY_RECORD_RULES[name] ?? []) {
    if (rule.kind !== "in-array" && matches(rule.path.split("."), path)) return rule.kind;
  }
  return null;
}

/** True when a user value at `path` replaces the shipped one as a whole (a `whole` or `opaque` record). */
export type ReplaceAt = (path: KeyPath) => boolean;

/** The `ReplaceAt` of a config, from its registered records. */
export function replaceRule(name: ConfigName): ReplaceAt {
  return (path) => {
    const kind = recordKindAt(name, path);
    return kind === "whole" || kind === "opaque";
  };
}

/** For reports: `a.b`, with a key that holds a dot (or is empty) quoted: `glossary["x.y"]`. */
export function formatKeyPath(path: KeyPath): string {
  return path.reduce((out, segment) => (/^[^.[\]"]+$/.test(segment) ? (out === "" ? segment : `${out}.${segment}`) : `${out}[${JSON.stringify(segment)}]`), "");
}
