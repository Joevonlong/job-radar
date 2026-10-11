import type { PipelineConfig } from "@/lib/config";
import type { Contract } from "@/lib/domain/types";

import { isAgencyCompany } from "./company";
import { compileRules, matchesAny } from "./rules";

export interface ContractInput {
  title: string;
  contractHint: string | null | undefined;
  description: string;
  companyName: string;
}

/**
 * Contract type from the posting's own words (patterns in pipeline.yaml). Order: student >
 * temp_agency (unless the posting says it is a direct hire) > freelance > fixed_term > permanent. Student and freelance only look at the title
 * and the channel's hint (a description mentioning "Praktikum" or "contractor" says little about
 * the job itself); the others also read the description. Nothing found: `unknown` (C3).
 */
export function detectContract(input: ContractInput, config: PipelineConfig): Contract {
  const rules = compileRules(config).contract;
  const head = `${input.title}\n${input.contractHint ?? ""}`;
  const all = `${head}\n${input.description}`;
  if (matchesAny(rules.student, head)) return "student";
  // A recruiter's own boilerplate ("Zeitarbeit und Personalvermittlung") is not the contract when the posting says it is a direct hire.
  if (matchesAny(rules.temp_agency, `${all}\n${input.companyName}`) && !matchesAny(rules.direct_hire, all)) return "temp_agency";
  if (matchesAny(rules.freelance, head)) return "freelance";
  if (matchesAny(rules.fixed_term, all)) return "fixed_term";
  if (matchesAny(rules.permanent, all)) return "permanent";
  return "unknown";
}

/** Whether the posting comes from a recruiter / staffing agency rather than the employer (channel flag, contract, wording, company name or name table). */
export function detectAgency(
  input: { title: string; description: string; companyName: string; flagged: boolean | undefined },
  config: PipelineConfig,
  contract: Contract,
): boolean {
  if (input.flagged === true || contract === "temp_agency") return true;
  if (agencyWording(`${input.title}\n${input.description}`, config)) return true;
  return isAgencyCompany(input.companyName, config);
}

/** Wording of a recruiter posting for a client, unless the text around it is an employer turning agencies away. */
function agencyWording(text: string, config: PipelineConfig): boolean {
  const rules = compileRules(config);
  const around = config.agency.exclude_context_chars;
  return rules.agencyText.some((pattern) =>
    [...text.matchAll(new RegExp(pattern.source, "giu"))].some((m) => {
      const from = Math.max(text.lastIndexOf("\n", m.index), m.index - around);
      const context = text.slice(Math.max(0, from), m.index + m[0].length + around);
      return !matchesAny(rules.agencyExclude, context);
    }),
  );
}
