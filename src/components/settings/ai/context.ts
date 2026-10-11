import type { AiDisclosureRow } from "@/lib/ai/disclosure";
import type { DraftValue, SettingsDraft, SettingsFieldError } from "@/lib/settings/draft";
import { SETTINGS_SECTIONS, type AiBlockId, type SectionDef } from "@/lib/settings/fields";

import type { CatalogContext, ProviderStates, Translator } from "../field-control";

/** What every block of the AI tab needs from the form: the draft, its change marks and errors, and the page's provider / catalog facts. */
export interface AiTabContext {
  base: string;
  draft: SettingsDraft;
  /** Paths of the fields that differ from the saved file. */
  dirty: ReadonlySet<string>;
  errors: Map<string, SettingsFieldError>;
  patch: (path: string, value: DraftValue) => void;
  t: Translator;
  providerStates: ProviderStates | undefined;
  catalog: CatalogContext | undefined;
  /** Current scores that changed scoring criteria would re-score (null: unknown). */
  criteriaImpact?: number | null;
  /** Per AI task the providers that may receive job text, from the saved ai.yaml (null: it cannot be read). */
  aiDisclosure?: AiDisclosureRow[] | null;
}

/** The sections of one block, in order. */
export const aiSectionsOf = (block: AiBlockId): SectionDef[] => SETTINGS_SECTIONS.ai.filter((section) => section.block === block);

export function aiSection(id: string): SectionDef {
  const found = SETTINGS_SECTIONS.ai.find((section) => section.id === id);
  if (!found) throw new Error(`unknown AI section ${id}`);
  return found;
}
