import type { BreakdownOutput } from "@/lib/ai/prompts/breakdown";

export const JD = [
  "Acme is hiring an AI Engineer.",
  "## What you will do",
  "- Build and operate retrieval pipelines in production.",
  "- Write clear documentation.",
  "## What you bring",
  "Our stack: Python, Kubernetes and AWS. Nice to have: Terraform.",
  "You have 5+ years of experience in software engineering.",
  "Fluent English is required.",
].join("\n");

export const emptyOutput = (): BreakdownOutput => ({
  responsibilities: [],
  tech_stack: [],
  experience: { years_min: null, years_quote: null, items: [] },
  projects: [],
  soft_skills: [],
  languages: [],
  other: [],
});
