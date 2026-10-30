import { foldTransliterated } from "@/lib/filter/text";

/** The input spelling first, followed by its city alias group's spellings, without duplicates. */
export function locationSearchTerms(q: string, cityAliases: Readonly<Record<string, readonly string[]>>, transliterations: Readonly<Record<string, string>> = {}): string[] {
  const text = q.trim();
  if (text === "") return [];
  const wanted = foldTransliterated(text, transliterations);
  const terms = new Set<string>([text]);
  for (const [canonical, aliases] of Object.entries(cityAliases)) {
    const names = [canonical, ...aliases];
    if (names.some((name) => foldTransliterated(name, transliterations) === wanted)) for (const name of names) terms.add(name);
  }
  return [...terms];
}
