/**
 * The five signal categories every installation started with (the tiers T1-T4 and the benefit tags before
 * categories were configurable). Their ids, names, icons, colours and AI definitions are what the interests.yaml
 * 1 -> 2 migration writes, and what the compatibility checks compare with: a catalog whose AI part equals these keeps
 * the `signals-v1` prompt word for word (no AI re-review after the upgrade). The vocabulary itself (words, patterns,
 * amount settings) always comes from the user's file. Pure data: client and server share it.
 */
import type { SignalColor } from "./palette";

export interface DefaultCategoryMeta {
  id: string;
  kind: "amount" | "keyword" | "tag";
  label: { zh: string; en: string };
  icon?: string;
  color: SignalColor;
  high_value: boolean;
  /** What the AI is told the category means (the tag category's is only used by the weekly suggestions). */
  ai_definition?: string;
  /** `signals.kind` of a keyword category's signals (the tiers had fixed ones). */
  default_kind?: string;
}

export const DEFAULT_AMOUNT_DEFINITION =
  'a concrete salary figure or range for the role (base salary, "€85,000-105,000", "up to 120k", "€7,200 per month"). Not company revenue, funding, prices, perks worth a fixed sum (e.g. a pension contribution or a voucher), or referral/relocation payments.';

export const DEFAULT_SIGNAL_CATEGORIES: readonly DefaultCategoryMeta[] = [
  { id: "T1", kind: "amount", label: { zh: "具体金额", en: "Explicit amount" }, icon: "💰", color: "amber", high_value: true, ai_definition: DEFAULT_AMOUNT_DEFINITION },
  {
    id: "T2",
    kind: "keyword",
    label: { zh: "股权", en: "Equity" },
    icon: "📈",
    color: "teal",
    high_value: true,
    ai_definition: 'equity-like compensation: stock options, ESOP/VSOP, RSUs, employee shares, virtual shares, employee participation programmes. Not "diversity, equity and inclusion", private equity, or investor names.',
    default_kind: "equity",
  },
  {
    id: "T3",
    kind: "keyword",
    label: { zh: "有竞争力", en: "Competitive" },
    icon: "🏅",
    color: "coral",
    high_value: false,
    ai_definition: 'the JD says in words that pay is good: "competitive salary", "above-market pay", "attractive compensation", "überdurchschnittliche Vergütung". Not generic "competitive market" or "competitive benefits" without pay.',
    default_kind: "competitive_pay",
  },
  {
    id: "T4",
    kind: "keyword",
    label: { zh: "奖金", en: "Bonus" },
    icon: "🎁",
    color: "blue",
    high_value: false,
    ai_definition: 'other money for the employee: bonus, signing bonus, 13th salary, profit sharing, variable pay. Not "bonus points if you know X", "a bonus if you have X", or referral bonuses.',
    default_kind: "bonus",
  },
  {
    id: "tag",
    kind: "tag",
    label: { zh: "福利", en: "Benefit" },
    color: "neutral",
    high_value: false,
    // only the weekly suggestions read it (tags are never reviewed by the AI)
    ai_definition: "a benefit worth showing as a tag (a travel ticket, a bike leasing programme, a sabbatical, a learning budget, ...).",
  },
];

export function defaultCategoryMeta(id: string): DefaultCategoryMeta | undefined {
  return DEFAULT_SIGNAL_CATEGORIES.find((category) => category.id === id);
}
