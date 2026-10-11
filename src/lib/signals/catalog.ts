/**
 * The signal category catalog, built from interests.yaml `signals`. Everything that used to know the tiers
 * T1-T4 asks the catalog instead: the order, the amount category, which categories go to the AI, which are high
 * value, the name in a language. Pure and free of server-only imports: the client components get `CategoryView`s.
 */
import type { AmountCategory, InterestsConfig, SignalCategory, SignalCategoryKind } from "@/lib/config/schemas/interests";

import type { SignalColor } from "./palette";

/** A category id as stored in `signals.tier` (the column kept its name). */
export type SignalCategoryId = string;

export interface SignalCatalog {
  /** The active categories, in display and sort order. */
  readonly categories: readonly SignalCategory[];
  /** Deleted categories (their stored signals are kept but not used). */
  readonly retired: readonly SignalCategory[];
  readonly byId: ReadonlyMap<string, SignalCategory>;
  /** The amount category, null when there is none. */
  readonly amount: AmountCategory | null;
  /** Categories the AI reviews and may add (amount and keyword), in order. */
  readonly aiIds: readonly string[];
  /** Categories whose signals make a job "high value". */
  readonly highValueIds: readonly string[];
  /** Position in the list; unknown and retired ids sort last. */
  order(id: string): number;
  /** Name in `locale`, falling back to English, Chinese, then the id. */
  labelOf(id: string, locale: string): string;
  /** An active category (retired and unknown ids are not). */
  isActive(id: string): boolean;
  /** `signals.kind` of a rule hit of a keyword category: `default_kind`, else the id in lower case. */
  kindOf(id: string): string;
}

/** Name of a category in `locale`: the locale's name, then English, then Chinese, then the id. */
export function categoryLabel(category: Pick<SignalCategory, "id" | "label">, locale: string): string {
  const own = locale === "zh" ? category.label.zh : locale === "en" ? category.label.en : undefined;
  return own ?? category.label.en ?? category.label.zh ?? category.id;
}

const cache = new WeakMap<object, SignalCatalog>();

/** The catalog of a loaded config (cached per `signals` object: a reload yields a new one). */
export function buildCatalog(interests: Pick<InterestsConfig, "signals">): SignalCatalog {
  const hit = cache.get(interests.signals);
  if (hit) return hit;
  const categories = interests.signals.categories;
  const byId = new Map(categories.map((category) => [category.id, category]));
  const position = new Map(categories.map((category, index) => [category.id, index]));
  const amount = categories.find((category): category is AmountCategory => category.kind === "amount") ?? null;
  const catalog: SignalCatalog = {
    categories,
    retired: interests.signals.retired_categories,
    byId,
    amount,
    aiIds: categories.filter((category) => category.kind !== "tag").map((category) => category.id),
    highValueIds: categories.filter((category) => category.high_value).map((category) => category.id),
    order: (id) => position.get(id) ?? categories.length,
    labelOf: (id, locale) => {
      const category = byId.get(id) ?? interests.signals.retired_categories.find((c) => c.id === id);
      return category ? categoryLabel(category, locale) : id;
    },
    isActive: (id) => byId.has(id),
    kindOf: (id) => {
      const category = byId.get(id);
      return category?.kind === "keyword" && category.default_kind !== undefined ? category.default_kind : id.toLowerCase();
    },
  };
  cache.set(interests.signals, catalog);
  return catalog;
}

/** What the client components know about a category (serializable). */
export interface CategoryView {
  id: string;
  kind: SignalCategoryKind;
  /** Name in the page's language. */
  label: string;
  icon: string | null;
  color: SignalColor;
  /** The short code a signal tag shows: the id when it is at most 4 characters, else null (the icon is shown). */
  code: string | null;
  highValue: boolean;
  weight: number;
}

/** Longest id a signal tag prints as its code. */
export const CATEGORY_CODE_MAX_CHARS = 4;

export function categoryCode(id: string): string | null {
  return id.length <= CATEGORY_CODE_MAX_CHARS ? id : null;
}

export function toCategoryView(category: SignalCategory, locale: string): CategoryView {
  return {
    id: category.id,
    kind: category.kind,
    label: categoryLabel(category, locale),
    icon: category.icon ?? null,
    color: category.color,
    code: categoryCode(category.id),
    highValue: category.high_value,
    weight: category.weight,
  };
}

/** The active categories as views, in order. */
export function toCategoryViews(catalog: SignalCatalog, locale: string): CategoryView[] {
  return catalog.categories.map((category) => toCategoryView(category, locale));
}

/** Lookup of views by id (client side). */
export function categoryViewMap(views: readonly CategoryView[]): ReadonlyMap<string, CategoryView> {
  return new Map(views.map((view) => [view.id, view]));
}
