/** Page-independent inputs for the detail panels and capability readers. */
import { loadConfig, type MeConfig, type AiConfig } from "@/lib/config";
import { loadPipeline } from "@/lib/market";
import type { JobDetail } from "@/lib/db/queries/job-detail";
import { annualBaseFigure } from "@/lib/domain/salary";
import { floorCheck } from "@/lib/dashboard/floor-check";
import { germanCheck } from "@/lib/dashboard/german-check";
import { buildSkillAliasMap, matchSkills, profileSkillKeys } from "@/lib/dashboard/skills";
import type { buildBreakdownView } from "@/lib/breakdown/view";
import { buildGhostCheckView } from "@/lib/ghost/view";
import { buildVisaCheckView } from "@/lib/visa/view";
import type { getSalaryContext } from "@/lib/salary/view";
import type { ResearchSettingsState } from "@/lib/research/settings";

export function loadDetailProfileInput() {
  let me: MeConfig | null;
  try {
    me = loadConfig("me");
  } catch {
    me = null;
  }
  return { profileSkills: me?.skills.map((skill) => skill.name) ?? [], profileYears: me?.years_experience ?? null, aliases: buildSkillAliasMap(loadPipeline().skills) };
}

export function detailChecks(job: Pick<JobDetail, "skills" | "germanLevelRequired" | "salary">, input: { profileSkills: readonly string[]; aliases: ReadonlyMap<string, string>; germanLabel: string | null; salaryFloor: number | null; currency: string }) {
  return {
    skillMatches: matchSkills(job.skills, profileSkillKeys(input.profileSkills, input.aliases), input.aliases),
    german: germanCheck(job.germanLevelRequired, input.germanLabel),
    floor: floorCheck(job.salary, input.salaryFloor, input.currency),
  };
}

export function detailCheckViews(job: Pick<JobDetail, "visa" | "ghost">, input: { visa: boolean; needsVisaSponsorship: boolean; ghost: boolean }) {
  return { visaView: input.visa ? buildVisaCheckView(job.visa, input.needsVisaSponsorship) : null, ghostView: input.ghost ? buildGhostCheckView(job.ghost) : null };
}

export function breakdownViewInput(job: Pick<JobDetail, "description">, input: Omit<Parameters<typeof buildBreakdownView>[0], "description">): Parameters<typeof buildBreakdownView>[0] {
  return { ...input, description: job.description };
}

export function salaryContextInput(job: Pick<JobDetail, "id" | "salary">, input: Omit<Parameters<typeof getSalaryContext>[1], "jobId" | "figure">): Parameters<typeof getSalaryContext>[1] {
  return { ...input, jobId: job.id, figure: annualBaseFigure(job.salary, input.currency) };
}

export function companyResearchInput(jobId: number, settings: ResearchSettingsState, ai: AiConfig | null, now: Date) {
  return { jobId, research: settings.state === "ok" ? settings.config : null, ai, now };
}
