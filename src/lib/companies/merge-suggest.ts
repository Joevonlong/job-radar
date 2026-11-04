import type { PipelineConfig } from "@/lib/config";
import { isTokenSpelling } from "@/lib/db/repos/companies";
import { normalizeCompanyKey, resolveCompanyName, storedCompanyKeys } from "@/lib/pipeline/company";

export interface MergeSuggestRow {
  id: number;
  name: string;
  nameNorm: string;
  aliases: readonly string[];
  watched: boolean;
  blacklisted: boolean;
  jobCount: number;
}

export interface MergeSuggestion {
  /** 1: the keys say it is one spelling. 2: a shorter name matches, which may be a parent and a subsidiary: a person decides. */
  tier: 1 | 2;
  /** The row the suggestion keeps. */
  into: MergeSuggestRow;
  /** The rows the suggestion folds into it. */
  from: MergeSuggestRow[];
}

/** Where a name's main part ends ("Boston Consulting Group (BCG)", "Acme | Berlin"). Syntax of a name, not a word list. */
const NAME_PART_END = /\(|\||–| - |,/;

/** Rows that share any key form one group. */
function groupByKeys(rows: readonly MergeSuggestRow[], keysOf: (row: MergeSuggestRow) => Iterable<string>): MergeSuggestRow[][] {
  const parent = new Map<number, number>();
  const find = (id: number): number => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root) as number;
    parent.set(id, root);
    return root;
  };
  const firstWithKey = new Map<string, number>();
  for (const row of rows) {
    parent.set(row.id, row.id);
    for (const key of keysOf(row)) {
      const first = firstWithKey.get(key);
      if (first === undefined) firstWithKey.set(key, row.id);
      else parent.set(find(row.id), find(first));
    }
  }
  const groups = new Map<number, MergeSuggestRow[]>();
  for (const row of rows) groups.set(find(row.id), [...(groups.get(find(row.id)) ?? []), row]);
  return [...groups.values()].filter((group) => group.length > 1);
}

/**
 * Which row stays: not a board-token spelling, then a row with a user's mark, then more jobs, then the older id. A row whose key
 * is another row's key run together goes after that other row before jobs count: of "Aleph Alpha" and "Alephalpha" the second
 * is a slug of the first however many jobs each has, and the name that stays is the one people read.
 */
function suggestionOf(tier: 1 | 2, group: readonly MergeSuggestRow[], isSlugOfGroup: (row: MergeSuggestRow) => boolean = () => false): MergeSuggestion {
  const ranked = group.map((row) => ({ row, rank: [isTokenSpelling(row.name) ? 1 : 0, row.watched || row.blacklisted ? 0 : 1, isSlugOfGroup(row) ? 1 : 0, -row.jobCount, row.id] }));
  ranked.sort((a, b) => {
    const index = a.rank.findIndex((value, i) => value !== b.rank[i]);
    return index < 0 ? 0 : (a.rank[index] as number) - (b.rank[index] as number);
  });
  const [into, ...from] = ranked.map(({ row }) => row);
  return { tier, into: into as MergeSuggestRow, from };
}

/** The key without its trailing words of the list; one word always stays. */
function keyWithoutTail(key: string, tailWords: ReadonlySet<string>): string {
  const words = key.split("-");
  while (words.length > 1 && tailWords.has(words[words.length - 1] as string)) words.pop();
  return words.join("-");
}

/**
 * Rows that may be one company, for a person to confirm; nothing here merges anything.
 * Tier 1: a stored key is shared, or is the same once its hyphens are gone ("Aleph Alpha" / "Alephalpha").
 * Tier 2: the same key once the trailing words of `company.duplicate_tail_words` are gone, or the same main part of the name.
 * A row tier 1 already folds is not listed again, so the lines of both tiers can stand in one plan.
 */
export function suggestCompanyMerges(rows: readonly MergeSuggestRow[], config: PipelineConfig): MergeSuggestion[] {
  const suffixes = config.company.legal_suffixes;
  const tierOne = groupByKeys(rows, (row) =>
    [...storedCompanyKeys(row, suffixes), resolveCompanyName(row.name, config).nameNorm].map((key) => key.replaceAll("-", "")).filter((key) => key !== ""),
  ).map((group) =>
    suggestionOf(1, group, (row) =>
      group.some((other) => other.id !== row.id && [...storedCompanyKeys(other, suffixes)].some((key) => key.includes("-") && key.replaceAll("-", "") === row.nameNorm)),
    ),
  );

  const folded = new Set(tierOne.flatMap((suggestion) => suggestion.from.map((row) => row.id)));
  const tailWords = new Set(config.company.duplicate_tail_words.map((word) => word.toLocaleLowerCase("en")));
  const tierTwo = groupByKeys(
    rows.filter((row) => !folded.has(row.id)),
    (row) => {
      const mainPart = normalizeCompanyKey((row.name.split(NAME_PART_END)[0] ?? "").trim(), suffixes);
      return [`tail:${keyWithoutTail(row.nameNorm, tailWords)}`, ...(mainPart === "" ? [] : [`part:${mainPart}`])];
    },
  ).map((group) => suggestionOf(2, group));

  return [...tierOne, ...tierTwo];
}
