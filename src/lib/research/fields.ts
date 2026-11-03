/** The shape of a stored company background. No server imports: the panel in the browser reads the field list too. */
export const COMPANY_RESEARCH_FIELDS = ["summary", "industry", "size", "founded", "headquarters", "funding", "products", "workingLanguage", "reviews", "recentNews"] as const;
export type CompanyResearchField = (typeof COMPANY_RESEARCH_FIELDS)[number];

export interface CompanyResearchView {
  id: number;
  companyId: number;
  fetchedAt: Date;
  /** An expired result is still returned; the caller decides how to say so. */
  expiresAt: Date | null;
  expired: boolean;
  /** The confirmed website domain the lookup used, if any. */
  domainUsed: string | null;
  provider: string | null;
  model: string | null;
  /** Only the fields that passed every check of `lib/research/verify.ts`. Several items of one field are separate lines of its text. */
  fields: Partial<Record<CompanyResearchField, { text: string; sourceUrl: string }>>;
  /** Fields removed by the checks. */
  dropped: number;
}
