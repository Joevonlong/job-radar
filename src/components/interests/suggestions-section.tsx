import { getLocale } from "next-intl/server";

import { loadSuggestionsSection } from "@/lib/interests/suggestion-view";

import { SuggestionsPanel } from "./suggestions";

/** Server wrapper: reads the suggestions and hands them to the client panel. */
export async function SuggestionsSection() {
  return <SuggestionsPanel data={await loadSuggestionsSection(await getLocale())} />;
}
