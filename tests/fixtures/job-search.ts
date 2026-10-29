import { buildCountryLexicon, parseSearchQuery, type SearchQuerySettings } from "@/lib/jobs/search-query";

/** Search fixtures own their vocabulary and settings, independently of shipped YAML. */
export const searchSettings: SearchQuerySettings = {
  maxChars: 200, maxTerms: 12, prefixMinChars: 4, cjkMinChars: 2,
  ranking: { weights: { title: 8, company: 5, location: 3, country: 3, description: 1, translation: 1 }, prefixFactor: 0.6 },
};
const lexicon = buildCountryLexicon([
  { code: "DE", name: "Germany", aliases: ["Deutschland"] },
  { code: "FR", name: "France" }, { code: "AT", name: "Austria" }, { code: "IT", name: "Italy" },
  { code: "CN", name: "China" }, { code: "US", name: "United States" }, { code: "PT", name: "Portugal" },
  { code: "CH", name: "Switzerland" }, { code: "MX", name: "Mexico" },
], { locales: ["en", "de", "zh"], ambiguousCodes: ["AI", "AT", "IN", "IS", "IT", "US"], extraAliases: {} });
export const searchContext = { lexicon, settings: searchSettings, cityAliases: { Munich: ["München", "Muenchen"] }, transliterations: { ü: "ue" } };
export const searchPlan = (q: string | null | undefined) => parseSearchQuery(q, searchContext);
