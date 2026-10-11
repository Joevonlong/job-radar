import type { PipelineConfig } from "@/lib/config";
import type { NormalizedPostingDraft } from "@/lib/channels/types";

import { compileRules, matchesAny } from "./rules";

type Workplace = NormalizedPostingDraft["workplace"];
type Mode = "remote" | "hybrid" | "onsite";

const MODES: readonly Mode[] = ["remote", "hybrid", "onsite"];

export interface WorkplaceInput {
  title: string;
  /** Location texts as the posting words them ("Berlin (Onsite)", "Remote, Germany"). */
  locationLabels: readonly string[];
  contractHint?: string | null | undefined;
  description: string;
}

const globalOf = (pattern: RegExp): RegExp => new RegExp(pattern.source, "giu");

/** The modes whose patterns match at least one of the texts. */
function headModes(patterns: Record<Mode, readonly RegExp[]>, texts: readonly string[]): Mode[] {
  return MODES.filter((mode) => texts.some((text) => text !== "" && matchesAny(patterns[mode], text)));
}

/** Whether a negation ("not", "nicht", "kein") stands before `index` in the same sentence, within the configured window. */
function negatedBefore(text: string, index: number, config: PipelineConfig, negation: readonly RegExp[]): boolean {
  const window = text.slice(Math.max(0, index - config.workplace.negation_window_chars), index);
  const sentence = window.slice(Math.max(window.lastIndexOf("."), window.lastIndexOf("\n"), window.lastIndexOf(";")) + 1);
  return matchesAny(negation, sentence);
}

/** The modes the description states, ignoring matches that a negation takes back. */
function textModes(description: string, config: PipelineConfig): Mode[] {
  const rules = compileRules(config);
  return MODES.filter((mode) =>
    rules.workplaceText[mode].some((pattern) => [...description.matchAll(globalOf(pattern))].some((m) => !negatedBefore(description, m.index, config, rules.workplaceNegation))),
  );
}

/**
 * Work mode from the posting's own words, for postings whose source does not state one (patterns in
 * pipeline.yaml `workplace`). The title, location texts and contract hint are read first (each on
 * its own); if they name exactly one mode that is it. Otherwise the description decides, with
 * stricter patterns and negations taken into account. Two different modes in the same place
 * ("remote or hybrid") mean the posting does not commit to one: `unknown`, never a guess (C3).
 */
export function extractWorkplace(input: WorkplaceInput, config: PipelineConfig): Workplace {
  const head = headModes(compileRules(config).workplaceHead, [input.title, ...input.locationLabels, input.contractHint ?? ""]);
  if (head.length === 1) return head[0] as Mode;
  if (head.length > 1) return "unknown";
  const text = textModes(input.description, config);
  return text.length === 1 ? (text[0] as Mode) : "unknown";
}

/**
 * Whether the description itself says the job is hybrid or on-site although the source labelled it "remote"
 * (a channel's generic "remote" tag follows the filter it searched with, the JD knows better). Only a
 * single explicit non-remote mode counts (strict `text` patterns, negations respected); anything else keeps
 * the source's label.
 */
export function workplaceOverridingRemoteLabel(description: string, config: PipelineConfig): "hybrid" | "onsite" | null {
  const text = textModes(description, config);
  if (text.length !== 1) return null;
  return text[0] === "hybrid" || text[0] === "onsite" ? text[0] : null;
}
