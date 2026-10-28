/**
 * Form draft of the signal category editor. A draft is what the browser holds and sends: plain strings
 * and lists. It is untrusted input, so it is validated with zod (C6), merged into the current config and validated
 * again with the real schema (the single source of truth, C8): fields the form does not show (the amount settings,
 * `default_kind`, limits, views, watched companies ...) are kept as they are.
 *
 * Rules the merge enforces (the schema cannot: it does not know the file before):
 * - a saved category keeps its id and its kind (a changed kind is a field error);
 * - no saved id disappears: a deleted category moves to `retired` with its saved definition (its signals stay in the
 *   database); a restored one comes back from there;
 * - a retired id is never used again (the schema's uniqueness check covers active + retired).
 *
 * Pure and free of server-only imports: the client form and the server action share it.
 */
import { z } from "zod";

import {
  MAX_SIGNAL_CATEGORIES,
  SIGNAL_CATEGORY_ID,
  SIGNAL_CATEGORY_KINDS,
  SIGNAL_REGEX_FLAGS,
  type InterestsConfig,
  type SignalCategory,
  type SignalCategoryKind,
} from "@/lib/config/schemas/interests";
import { SIGNAL_COLORS, type SignalColor } from "@/lib/signals/palette";

export interface CategoryDraft {
  /** Fixed once saved. */
  id: string;
  /** Fixed once saved. */
  kind: SignalCategoryKind;
  labelZh: string;
  labelEn: string;
  icon: string;
  color: SignalColor;
  /** Points, as typed. */
  weight: string;
  highValue: boolean;
  /** Amount and keyword categories only. */
  aiConfirmOnly: boolean;
  aiDefinition: string;
  /** Keyword categories: literal terms, matched on word boundaries. */
  keywords: string[];
  /** Amount and keyword categories: regular expressions (flags "iu"). */
  patterns: string[];
  /** Amount and keyword categories: regular expressions that veto a hit. */
  exclude: string[];
  /** Tag categories: literal tag names. */
  tags: string[];
  /** Tag categories: a tag name shown when its pattern matches. */
  tagPatterns: Array<{ name: string; pattern: string }>;
}

export interface VocabularyDraft {
  /** The active categories, in display order. */
  categories: CategoryDraft[];
  /** Deleted categories (only their ids count: the saved definition is kept as it was). */
  retired: CategoryDraft[];
  /** Cap of the summed points, as typed. */
  bonusCap: string;
}

const stringArray = z.array(z.string().max(2000)).max(500);
export const categoryDraftSchema = z.strictObject({
  id: z.string().max(60),
  kind: z.enum(SIGNAL_CATEGORY_KINDS),
  labelZh: z.string().max(200),
  labelEn: z.string().max(200),
  icon: z.string().max(40),
  color: z.enum(SIGNAL_COLORS),
  weight: z.string().max(40),
  highValue: z.boolean(),
  aiConfirmOnly: z.boolean(),
  aiDefinition: z.string().max(4000),
  keywords: stringArray,
  patterns: stringArray,
  exclude: stringArray,
  tags: stringArray,
  tagPatterns: z.array(z.strictObject({ name: z.string().max(200), pattern: z.string().max(2000) })).max(200),
});

export const vocabularyDraftSchema = z.strictObject({
  categories: z.array(categoryDraftSchema).max(MAX_SIGNAL_CATEGORIES * 2),
  retired: z.array(categoryDraftSchema).max(MAX_SIGNAL_CATEGORIES * 2),
  bonusCap: z.string().max(40),
});

/** Whether `source` compiles as a signal pattern; the form checks rows while typing. */
export function isValidPattern(source: string): boolean {
  try {
    new RegExp(source, SIGNAL_REGEX_FLAGS);
    return true;
  } catch {
    return false;
  }
}

/** Whether `id` has the format of a category id (the add dialog checks it while typing). */
export function isValidCategoryId(id: string): boolean {
  return SIGNAL_CATEGORY_ID.test(id);
}

// ---------------------------------------------------------------- config <-> draft

export function categoryToDraft(category: SignalCategory): CategoryDraft {
  const draft: CategoryDraft = {
    id: category.id,
    kind: category.kind,
    labelZh: category.label.zh ?? "",
    labelEn: category.label.en ?? "",
    icon: category.icon ?? "",
    color: category.color,
    weight: String(category.weight),
    highValue: category.high_value,
    aiConfirmOnly: category.kind === "tag" ? false : category.ai_confirm_only === true,
    aiDefinition: category.ai_definition ?? "",
    keywords: [],
    patterns: [],
    exclude: [],
    tags: [],
    tagPatterns: [],
  };
  if (category.kind === "keyword") return { ...draft, keywords: [...category.keywords], patterns: [...category.patterns], exclude: [...category.exclude] };
  if (category.kind === "amount") return { ...draft, patterns: [...category.patterns], exclude: [...category.exclude] };
  return { ...draft, tags: [...category.tags], tagPatterns: category.tag_patterns.map((entry) => ({ name: entry.name, pattern: entry.pattern })) };
}

export function configToDraft(config: Pick<InterestsConfig, "signals" | "bonus_cap">): VocabularyDraft {
  return {
    categories: config.signals.categories.map(categoryToDraft),
    retired: config.signals.retired_categories.map(categoryToDraft),
    bonusCap: String(config.bonus_cap),
  };
}

/**
 * A new category of `kind` (the add dialog fills id, names and colour). `from` (a preset) supplies the other
 * fields; the dialog's id, kind, names and colour always win.
 */
export function newCategoryDraft(
  input: { id: string; kind: SignalCategoryKind; labelZh: string; labelEn: string; color: SignalColor },
  from?: Partial<CategoryDraft>,
): CategoryDraft {
  const empty: CategoryDraft = { ...input, icon: "", weight: "0", highValue: false, aiConfirmOnly: false, aiDefinition: "", keywords: [], patterns: [], exclude: [], tags: [], tagPatterns: [] };
  return { ...empty, ...from, ...input };
}

const DECIMAL = /^-?\d+(\.\d+)?$/;

/** Text -> number; empty is "required" (undefined), anything that is not a plain decimal is NaN ("not a number"). */
function toNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  return DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** The kept (non-blank, trimmed) entries of a list, and for each the index it had in the draft. */
function compact(list: readonly string[]): { values: string[]; origins: number[] } {
  const values: string[] = [];
  const origins: number[] = [];
  list.forEach((entry, index) => {
    const trimmed = entry.trim();
    if (trimmed === "") return;
    values.push(trimmed);
    origins.push(index);
  });
  return { values, origins };
}

const blankToUndefined = (text: string): string | undefined => (text.trim() === "" ? undefined : text.trim());

/** Why a draft cannot be merged at all (not tied to one field). */
export type DraftMergeError = "categoryMissing" | "unknownRetired";

export interface DraftCandidate {
  /** The unvalidated config candidate (feed it to `interestsSchema`). */
  candidate: unknown;
  /** Draft-space path of a config-space issue path (blank rows were dropped, so indexes move). */
  draftPath: (path: ReadonlyArray<PropertyKey>) => string;
  /** Problems the merge itself found, as field errors in draft space (a changed kind). */
  fieldErrors: VocabularyFieldError[];
}

/**
 * Merge a draft into the current config: the edited parts replace theirs, everything else stays. Returns a whole-form
 * error when a saved category is neither active nor retired in the draft, or the draft retires an id the file does not have.
 */
export function draftToCandidate(draft: VocabularyDraft, current: InterestsConfig): DraftCandidate | DraftMergeError {
  const saved = new Map<string, SignalCategory>();
  for (const category of [...current.signals.categories, ...current.signals.retired_categories]) saved.set(category.id, category);
  const mentioned = new Set([...draft.categories, ...draft.retired].map((category) => category.id));
  for (const id of saved.keys()) if (!mentioned.has(id)) return "categoryMissing";
  if (draft.retired.some((category) => !saved.has(category.id))) return "unknownRetired";

  const origins = new Map<string, number[]>();
  const list = (path: string, entries: readonly string[]): string[] => {
    const { values, origins: kept } = compact(entries);
    origins.set(path, kept);
    return values;
  };
  const fieldErrors: VocabularyFieldError[] = [];

  const categories = draft.categories.map((entry, index): unknown => {
    const previous = saved.get(entry.id);
    if (previous && previous.kind !== entry.kind) fieldErrors.push({ path: `categories.${index}.kind`, key: "kindLocked" });
    const kind = previous?.kind ?? entry.kind;
    const at = `signals.categories.${index}`;
    // the schema defaults a missing weight to 0; in the form an emptied field is a mistake
    if (entry.weight.trim() === "") fieldErrors.push({ path: `categories.${index}.weight`, key: "required" });
    const head = {
      id: entry.id.trim(),
      kind,
      label: { zh: blankToUndefined(entry.labelZh), en: blankToUndefined(entry.labelEn) },
      icon: blankToUndefined(entry.icon),
      color: entry.color,
      weight: toNumber(entry.weight),
      high_value: entry.highValue,
    };
    if (kind === "tag") {
      const rows = entry.tagPatterns.map((row, rowIndex) => ({ row, rowIndex })).filter(({ row }) => row.name.trim() !== "" || row.pattern.trim() !== "");
      origins.set(`${at}.tag_patterns`, rows.map(({ rowIndex }) => rowIndex));
      return {
        ...head,
        ...(entry.aiConfirmOnly ? { ai_confirm_only: true } : {}),
        ai_definition: blankToUndefined(entry.aiDefinition),
        tags: list(`${at}.tags`, entry.tags),
        tag_patterns: rows.map(({ row }) => ({ name: row.name.trim(), pattern: row.pattern.trim() })),
      };
    }
    const common = {
      ...head,
      ai_confirm_only: entry.aiConfirmOnly ? true : undefined,
      ai_definition: blankToUndefined(entry.aiDefinition),
    };
    if (kind === "amount") {
      return {
        ...common,
        patterns: list(`${at}.patterns`, entry.patterns),
        exclude: list(`${at}.exclude`, entry.exclude),
        // the amount settings are edited in the YAML: kept as saved
        ...(previous?.kind === "amount" ? { amount: previous.amount } : {}),
      };
    }
    return {
      ...common,
      ...(previous?.kind === "keyword" && previous.default_kind !== undefined ? { default_kind: previous.default_kind } : {}),
      keywords: list(`${at}.keywords`, entry.keywords),
      patterns: list(`${at}.patterns`, entry.patterns),
      exclude: list(`${at}.exclude`, entry.exclude),
    };
  });
  // a retired category keeps the definition it was saved with (edits made before deleting it are dropped)
  const retired = draft.retired.flatMap((entry) => {
    const previous = saved.get(entry.id);
    return previous ? [previous] : [];
  });

  const candidate = {
    ...current,
    signals: { ...current.signals, categories, retired_categories: retired },
    bonus_cap: toNumber(draft.bonusCap),
  };

  const draftPath = (path: ReadonlyArray<PropertyKey>): string => {
    const parts = path.map(String);
    const [root, group, index, field, sub, subField] = parts;
    if (root === "bonus_cap") return "bonusCap";
    if (root !== "signals") return parts.join(".");
    if (group === "retired_categories") return ["retired", index, field].filter((part): part is string => part !== undefined).join(".");
    if (group !== "categories" || index === undefined) return parts.join(".");
    const base = `categories.${index}`;
    if (field === undefined) return base;
    const mapIndex = (configList: string, draftField: string): string => {
      if (sub === undefined) return `${base}.${draftField}`;
      const position = Number(sub);
      const mapped = Number.isInteger(position) ? (origins.get(`signals.categories.${index}.${configList}`)?.[position] ?? position) : sub;
      return [`${base}.${draftField}`, String(mapped), subField].filter((part): part is string => part !== undefined).join(".");
    };
    switch (field) {
      case "label":
        return sub === "zh" ? `${base}.labelZh` : sub === "en" ? `${base}.labelEn` : `${base}.label`;
      case "high_value":
        return `${base}.highValue`;
      case "ai_confirm_only":
        return `${base}.aiConfirmOnly`;
      case "ai_definition":
        return `${base}.aiDefinition`;
      case "keywords":
      case "patterns":
      case "exclude":
      case "tags":
        return mapIndex(field, field);
      case "tag_patterns":
        return mapIndex("tag_patterns", "tagPatterns");
      default:
        return `${base}.${field}`;
    }
  };
  return { candidate, draftPath, fieldErrors };
}

// ---------------------------------------------------------------- errors

export type VocabularyErrorKey =
  | "required"
  | "number"
  | "min"
  | "max"
  | "atLeastOne"
  | "duplicates"
  | "regex"
  | "invalid"
  | "idFormat"
  | "idReserved"
  | "amountTaken"
  | "kindLocked"
  | "tooMany"
  | "nameRequired"
  | "iconTooLong"
  | "color"
  | "slowPattern";

export interface VocabularyFieldError {
  /** Draft-space path: `bonusCap`, `categories.2.weight`, `categories.1.keywords`, `categories.0.patterns.3`, `categories.4.tagPatterns.0.pattern` ... */
  path: string;
  key: VocabularyErrorKey;
  params?: Record<string, string | number>;
}

function issueKey(issue: z.core.$ZodIssue): Pick<VocabularyFieldError, "key" | "params"> {
  const field = String(issue.path.at(-1) ?? "");
  switch (issue.code) {
    case "invalid_type":
      return { key: /received undefined/.test(issue.message) ? "required" : "number" };
    case "too_small":
      if (issue.origin === "array") return { key: "atLeastOne" };
      if (issue.origin === "string") return { key: "required" };
      return { key: "min", params: { min: Number(issue.minimum) } };
    case "too_big":
      if (issue.origin === "array" && field === "categories") return { key: "tooMany", params: { max: Number(issue.maximum) } };
      return { key: "max", params: { max: Number(issue.maximum) } };
    case "invalid_format":
      return field === "id" ? { key: "idFormat" } : { key: "invalid", params: { message: issue.message } };
    case "invalid_value":
      return field === "color" ? { key: "color" } : { key: "invalid", params: { message: issue.message } };
    case "custom":
      if (issue.message === "must not contain duplicates") return { key: "duplicates" };
      if (issue.message === "must be a valid regular expression") return { key: "regex" };
      if (issue.message === "is a reserved id") return { key: "idReserved" };
      if (issue.message === "only one amount category is allowed") return { key: "amountTaken" };
      if (issue.message === "needs a name in at least one language") return { key: "nameRequired" };
      if (/^must be at most \d+ characters$/.test(issue.message) && field === "icon") return { key: "iconTooLong" };
      return { key: "invalid", params: { message: issue.message } };
    default:
      return { key: "invalid", params: { message: issue.message } };
  }
}

/** Zod issues of the config schema -> field errors addressed in draft space (one per field and kind). */
export function toFieldErrors(error: z.ZodError, draftPath: DraftCandidate["draftPath"]): VocabularyFieldError[] {
  const seen = new Set<string>();
  const out: VocabularyFieldError[] = [];
  for (const issue of error.issues) {
    const path = draftPath(issue.path);
    const mapped = issueKey(issue);
    const id = `${path}|${mapped.key}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ path, ...mapped });
  }
  return out;
}
