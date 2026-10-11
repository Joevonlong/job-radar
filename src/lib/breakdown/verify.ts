/** Quote check of a breakdown (C7): every item must quote the JD; the ones that do not are dropped and counted. */
import type { BreakdownOutput } from "@/lib/ai/prompts/breakdown";
import { skillKey } from "@/lib/dashboard/skills";
import { locateQuote } from "@/lib/signals/quote";

import type { BreakdownContent } from "./content";

export interface VerifiedBreakdown {
  content: BreakdownContent;
  /** Items whose quote is not in the JD. */
  dropped: number;
  /** Items the model returned (the years line included). */
  returned: number;
}

type Located<T> = T & { quote: string; offset: number };

export function verifyBreakdown(output: BreakdownOutput, description: string): VerifiedBreakdown {
  let dropped = 0;
  let returned = 0;

  /** Keep the entries whose quote is in the JD, with the JD's own text and offset. */
  function locate<T extends { quote: string }>(entries: readonly T[]): Array<Located<Omit<T, "quote">>> {
    const out: Array<Located<Omit<T, "quote">>> = [];
    for (const entry of entries) {
      returned += 1;
      const found = locateQuote(description, entry.quote);
      if (!found) {
        dropped += 1;
        continue;
      }
      const { quote: _original, ...rest } = entry;
      void _original;
      out.push({ ...rest, quote: found.quote, offset: found.offset });
    }
    return out;
  }

  const responsibilities = locate(output.responsibilities).map((e) => ({ ...e, text: e.text.trim() }));
  const projects = locate(output.projects).map((e) => ({ ...e, text: e.text.trim() }));
  const softSkills = locate(output.soft_skills).map((e) => ({ ...e, text: e.text.trim() }));
  const other = locate(output.other).map((e) => ({ ...e, text: e.text.trim() }));
  const experienceItems = locate(output.experience.items).map((e) => ({ ...e, text: e.text.trim() }));
  const languages = locate(output.languages).map((e) => ({ ...e, language: e.language.trim() }));

  // Tech stack: one entry per skill key (first wins, `must` beats `nice`); merging is not a drop.
  const techStack: BreakdownContent["tech_stack"] = [];
  const byKey = new Map<string, number>();
  for (const entry of locate(output.tech_stack)) {
    const name = entry.name.trim();
    const key = skillKey(name);
    const at = byKey.get(key);
    if (at === undefined) {
      byKey.set(key, techStack.length);
      techStack.push({ ...entry, name });
      continue;
    }
    const kept = techStack[at];
    if (kept && kept.requirement === "nice" && entry.requirement === "must") techStack[at] = { ...kept, requirement: "must" };
  }

  let yearsMin = output.experience.years_min;
  let yearsQuote: { quote: string; offset: number } | null = null;
  if (yearsMin !== null) {
    returned += 1;
    const found = output.experience.years_quote === null ? null : locateQuote(description, output.experience.years_quote);
    if (found) yearsQuote = found;
    else {
      yearsMin = null;
      dropped += 1;
    }
  }

  return {
    content: {
      responsibilities,
      tech_stack: techStack,
      experience: { years_min: yearsMin, years_quote: yearsQuote, items: experienceItems },
      projects,
      soft_skills: softSkills,
      languages,
      other,
    },
    dropped,
    returned,
  };
}
