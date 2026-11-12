import { researchSchema } from "@/lib/config";
import type { AutoResearchDeps } from "@/lib/research/auto";
import { pinnedAi } from "../ai/helpers";

export function trackingResearchDeps(): AutoResearchDeps {
  return {
    research: () => researchSchema.parse({
      enabled: true,
      company: { ttl_days: 30, max_per_day: 100, max_searches: 4, timeout_seconds: 60, max_field_chars: 400, allowed_domains: ["example.com"], non_company_hosts: [], employees: { min: 1, max: 1000000 }, rating: { min: 0, max: 5 }, web_search_usd: 0.01 },
      auto: { trigger: "favorite_or_applying", items: ["company"], max_per_day: 100, high_score: { enabled: false, min_rank: 80, per_cycle_limit: 2, max_age_days: 3, max_per_day: 5 } },
    }),
    ai: () => pinnedAi((raw) => { (raw.tasks as Record<string, unknown>).company_research = { order: ["anthropic"] }; }),
    salary: () => ({ state: "error", problem: "disabled in fixture" }),
    breakdown: () => ({ state: "error", problem: "disabled in fixture" }),
    timeZone: () => "UTC", process: "web", webOpen: async () => true,
  };
}
