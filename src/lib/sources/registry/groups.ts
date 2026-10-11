/** The groups of the source registry, in display order. A module of its own so client components can import it without the channel registry. */
export const REGISTRY_GROUPS = ["linkedin", "job_boards", "search_apis", "email", "ats", "discovery"] as const;
export type RegistryGroup = (typeof REGISTRY_GROUPS)[number];
