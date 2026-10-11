import type { PipelineConfig } from "@/lib/config";
import type { NormalizedPostingDraft } from "@/lib/channels/types";
import { inferSeniority } from "@/lib/domain/seniority";
import type { Contract, GermanLevel, JobLanguage, JobLocation, JobSalary, Seniority } from "@/lib/domain/types";

import { detectAgency, detectContract } from "./contract";
import { cleanDescription } from "./description";
import { normalizeDraftLocations } from "./geography";
import { detectLanguage, extractGermanLevel } from "./language";
import { normalizeSalary } from "./salary";
import { cleanTitle, stripHtml } from "./sanitize";
import { simhash } from "./simhash";
import { extractSkills } from "./skills";
import { extractWorkplace, workplaceOverridingRemoteLabel } from "./workplace";

export interface NormalizedJob {
  title: string;
  titleNorm: string;
  /** The company as the posting names it (before alias / legal-suffix resolution). */
  companyName: string;
  locations: JobLocation[];
  workplace: NormalizedPostingDraft["workplace"];
  seniority: Seniority;
  contract: Contract;
  isAgency: boolean;
  salary: JobSalary | null;
  /** Plain text. */
  description: string;
  language: JobLanguage;
  germanLevelRequired: GermanLevel;
  postedAt: Date | null;
  simhash: string | null;
  skills: string[];
  applyUrl: string | null;
  sourceUrl: string | null;
}

/** "(m/w/d)", "(f/m/x)", "(all genders)", "(gn)", "m/f/d" gender markers. */
const GENDER_MARKER = /[([]?\s*\b(?:[mwfdxi*]\s*[/|\\]\s*[mwfdxi*](?:\s*[/|\\]\s*[mwfdxi*])?|all\s+genders?|gn)\b\s*[)\]]?/giu;

/**
 * Title key for matching the same posting across sources: lower case, accents folded, gender
 * markers ("(m/w/d)") and punctuation removed, whitespace collapsed.
 */
export function normalizeTitle(title: string): string {
  return title
    .replace(/ß/g, "ss")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(GENDER_MARKER, " ")
    .replace(/[:*/]in(?:nen)?\b/giu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9+#]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * A validated draft -> the normalized job fields. Pure: no database, no clock. Nothing the posting
 * does not state is invented (C3): unknown stays `unknown` / null.
 */
export function normalizeDraft(draft: NormalizedPostingDraft, config: PipelineConfig): NormalizedJob {
  const title = cleanTitle(draft.title);
  const description = cleanDescription(stripHtml(draft.description), config);
  const locations = normalizeDraftLocations(draft.locations, config.market);
  const contract = detectContract({ title, contractHint: draft.contractHint, description, companyName: draft.companyName }, config);
  const seniorityFromTitle = inferSeniority(title);

  return {
    title,
    titleNorm: normalizeTitle(title),
    companyName: draft.companyName.trim(),
    locations,
    // the source's own value wins; only when it states none is the posting's wording read (C3: nothing is invented)
    workplace:
      draft.workplace === "remote"
        ? (workplaceOverridingRemoteLabel(description, config) ?? "remote") // a generic "remote" channel label yields to a JD that says hybrid / on-site
        : draft.workplace !== "unknown"
          ? draft.workplace
            : extractWorkplace({ title, locationLabels: locations.map((l) => l.label), contractHint: draft.contractHint, description }, config),
    seniority: seniorityFromTitle !== "unknown" ? seniorityFromTitle : inferSeniority(draft.seniorityHint ?? ""),
    contract,
    isAgency: detectAgency({ title, description, companyName: draft.companyName, flagged: draft.isAgency }, config, contract),
    salary: normalizeSalary({ ...draft, description }, config),
    description,
    language: detectLanguage(description, config, draft.descriptionLanguage),
    germanLevelRequired: extractGermanLevel(`${title}\n${description}`, config),
    postedAt: draft.postedAt ?? null,
    simhash: simhash(description, { shingleWords: config.dedupe.simhash_shingle_words, minWords: config.dedupe.simhash_min_words }),
    skills: extractSkills(`${title}\n${description}`, config),
    applyUrl: draft.applyUrl,
    sourceUrl: draft.sourceUrl,
  };
}
