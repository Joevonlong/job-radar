import { isGermanRequirement, type GermanLevel } from "@/lib/domain/types";

/** CEFR levels, lowest first (the same six steps the `LevelScale` draws). */
const CEFR_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type CefrLevel = (typeof CEFR_LEVELS)[number];

/**
 * What the German block of the checks card says (C3: a requirement the posting does not state is never guessed).
 * - `not_required`: the posting says German is not needed. `preferred`: nice to have, no deduction.
 * - `unknown`: the posting does not say. `met` / `gap`: it asks for a level, and yours reaches it or not.
 * - `no_german`: it asks for a level and your profile lists no German.
 */
export type GermanCheckState = "not_required" | "preferred" | "unknown" | "met" | "gap" | "no_german";

export interface GermanCheck {
  state: GermanCheckState;
  /** Your level on the A1-C2 scale (`native` sits on C2); null = none listed. */
  mine: CefrLevel | null;
  /** Your German is native (`me.yaml: de: native`). */
  native: boolean;
  /** The level the posting asks for; null unless it names one. */
  required: CefrLevel | null;
  /** Levels you are short of; 0 unless `state` is `gap`. */
  gap: number;
}

const isCefr = (value: string): value is CefrLevel => (CEFR_LEVELS as readonly string[]).includes(value);

/** `mineLabel` is `me.yaml` German as `userGermanLabelOrNull` gives it ("B1", "native", or null). */
export function germanCheck(requiredLevel: GermanLevel, mineLabel: string | null): GermanCheck {
  const native = mineLabel === "native";
  const mine: CefrLevel | null = native ? "C2" : mineLabel !== null && isCefr(mineLabel) ? mineLabel : null;
  if (!isGermanRequirement(requiredLevel) || !isCefr(requiredLevel)) {
    const state = requiredLevel === "none" ? "not_required" : requiredLevel === "preferred" ? "preferred" : "unknown";
    return { state, mine, native, required: null, gap: 0 };
  }
  if (mine === null) return { state: "no_german", mine, native, required: requiredLevel, gap: 0 };
  const gap = CEFR_LEVELS.indexOf(requiredLevel) - CEFR_LEVELS.indexOf(mine);
  return gap > 0 ? { state: "gap", mine, native, required: requiredLevel, gap } : { state: "met", mine, native, required: requiredLevel, gap: 0 };
}
