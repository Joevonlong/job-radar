/**
 * The JD points the workbench offers: the items of the job's breakdown, each with its JD quote. Breakdown items have no
 * id, so a choice is stored as quote + offset (`JdPointRef`); a choice the current breakdown no longer has is stale.
 */
import type { BreakdownContent } from "@/lib/breakdown/content";
import type { RequirementLevel } from "@/lib/breakdown/constants";

import type { JdPointRef } from "./types";

export const JD_POINT_GROUPS = ["responsibilities", "tech_stack", "experience", "projects", "soft_skills", "languages", "other"] as const;
export type JdPointGroup = (typeof JD_POINT_GROUPS)[number];

export interface JdPoint {
  group: JdPointGroup;
  text: string;
  quote: string;
  offset: number;
  requirement: RequirementLevel | null;
}

export function jdPointsOf(content: BreakdownContent): JdPoint[] {
  const points: JdPoint[] = [];
  for (const item of content.responsibilities) points.push({ group: "responsibilities", text: item.text, quote: item.quote, offset: item.offset, requirement: null });
  for (const item of content.tech_stack) points.push({ group: "tech_stack", text: item.name, quote: item.quote, offset: item.offset, requirement: item.requirement });
  if (content.experience.years_min !== null && content.experience.years_quote !== null) {
    const { quote, offset } = content.experience.years_quote;
    points.push({ group: "experience", text: quote, quote, offset, requirement: "must" });
  }
  for (const item of content.experience.items) points.push({ group: "experience", text: item.text, quote: item.quote, offset: item.offset, requirement: item.requirement });
  for (const item of content.projects) points.push({ group: "projects", text: item.text, quote: item.quote, offset: item.offset, requirement: item.requirement });
  for (const item of content.soft_skills) points.push({ group: "soft_skills", text: item.text, quote: item.quote, offset: item.offset, requirement: item.requirement });
  for (const item of content.languages) points.push({ group: "languages", text: `${item.language} (${item.level})`, quote: item.quote, offset: item.offset, requirement: item.requirement });
  for (const item of content.other) points.push({ group: "other", text: item.text, quote: item.quote, offset: item.offset, requirement: item.requirement });
  return points;
}

export const jdPointKey = (point: JdPointRef): string => `${point.offset}:${point.quote}`;

/**
 * The chosen points the breakdown still has, and how many choices are stale. A choice whose offset moved (a new breakdown
 * of an edited JD) is found again by its quote; one whose quote the breakdown no longer has is stale. `refs`: the choices
 * with their current offsets (stale ones as they were), what the workbench shows as ticked.
 */
export function resolveJdPoints(points: readonly JdPoint[], chosen: readonly JdPointRef[]): { points: JdPoint[]; stale: number; refs: JdPointRef[] } {
  const byKey = new Map(points.map((point) => [jdPointKey(point), point]));
  const used = new Set<JdPoint>();
  const out: JdPoint[] = [];
  const refs: JdPointRef[] = [];
  let stale = 0;
  for (const ref of chosen) {
    const point = byKey.get(jdPointKey(ref)) ?? points.find((candidate) => !used.has(candidate) && candidate.quote === ref.quote);
    if (point && !used.has(point)) {
      used.add(point);
      out.push(point);
      refs.push({ quote: point.quote, offset: point.offset });
    } else {
      stale += 1;
      refs.push(ref);
    }
  }
  return { points: out, stale, refs };
}
