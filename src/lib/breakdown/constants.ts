/** Tech-stack categories, in display order (part of the output schema: changing them means a new BREAKDOWN_PROMPT_VERSION). */
export const TECH_CATEGORIES = ["languages", "frameworks", "ml_ai", "data", "cloud_infra", "tools", "other"] as const;
export type TechCategory = (typeof TECH_CATEGORIES)[number];

export const REQUIREMENT_LEVELS = ["must", "nice"] as const;
export type RequirementLevel = (typeof REQUIREMENT_LEVELS)[number];

/** Spoken-language level: CEFR, native, or not stated. */
export const SPOKEN_LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2", "native", "unspecified"] as const;
export type SpokenLevel = (typeof SPOKEN_LEVELS)[number];

/** Output limits of breakdown-v1 (list lengths, characters). Part of the schema contract, like MAX_FIT_REASONS. */
export const BREAKDOWN_LIMITS = {
  responsibilities: 12,
  techStack: 30,
  experience: 8,
  projects: 6,
  softSkills: 8,
  languages: 4,
  other: 6,
  /** What the prompt asks for (Chinese characters); the schema allows `textMax`. */
  textAsk: 40,
  textMax: 120,
  nameMax: 40,
  /** What the prompt asks for; the schema allows `quoteMax` (a longer quote is still verified against the JD). */
  quoteAsk: 200,
  quoteMax: 400,
} as const;
