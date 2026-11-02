// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildCompanyResearchPrompt } from "@/lib/ai/prompts/company-research";
import { claudeWebToolArgs } from "@/lib/ai/providers/claude-cli";
import { resolveProviderOrder } from "@/lib/ai/router";
import { WEB_ACCESS_TASKS, isCompanyWebsiteCandidate, publicWebsiteDomains, webAccessAllowed, webLimits } from "@/lib/ai/web-tasks";
import { researchSchema } from "@/lib/config";
import { confirmedWebsiteDomain } from "@/lib/db/repos/company-research";

import { pinnedAi } from "../ai/helpers";
import { shippedYaml } from "../config/helpers";

/** What may leave the machine for a company background. The boundary of the feature: a change here is a security change. */
describe("what a company lookup sends out", () => {
  it("sends the cleaned company name, and the confirmed domain when there is one", () => {
    const named = buildCompanyResearchPrompt({ company: "Acme <b>Robotics</b>\nGmbH", confirmedDomain: null, maxSearches: 8 });
    expect(named.user).toContain("Acme");
    expect(named.user).not.toContain("<b>");
    expect(named.user).not.toContain("<website>");
    const withDomain = buildCompanyResearchPrompt({ company: "Acme", confirmedDomain: "acme-robotics.com", maxSearches: 8 });
    expect(withDomain.user).toContain("<website>acme-robotics.com</website>");
  });

  it("takes nothing else: the prompt input has no field for a title, a place, the JD or the profile", () => {
    const input = { company: "Acme", confirmedDomain: null, maxSearches: 8 } satisfies Parameters<typeof buildCompanyResearchPrompt>[0];
    expect(Object.keys(input).sort()).toEqual(["company", "confirmedDomain", "maxSearches"]);
  });

  it("treats only a domain the user confirmed as confirmed", () => {
    expect(confirmedWebsiteDomain({ websiteDomain: "acme-robotics.com", websiteDomainSource: "user" })).toBe("acme-robotics.com");
    expect(confirmedWebsiteDomain({ websiteDomain: "acme-inferred.com", websiteDomainSource: "inferred" })).toBeNull();
    expect(confirmedWebsiteDomain({ websiteDomain: null, websiteDomainSource: null })).toBeNull();
  });

  it("does not trust a stored row: a confirmed domain that is not a public name is not used", () => {
    for (const bad of ["192.168.1.1", "fritz.box", "printer.local", "169.254.169.254"]) {
      expect(confirmedWebsiteDomain({ websiteDomain: bad, websiteDomainSource: "user" }), bad).toBeNull();
    }
  });

  it("gives the claude-cli web tool arguments for the allowed sites and the confirmed domain only", () => {
    const confirmed = confirmedWebsiteDomain({ websiteDomain: "acme-robotics.com", websiteDomainSource: "user" });
    const inferred = confirmedWebsiteDomain({ websiteDomain: "acme-inferred.com", websiteDomainSource: "inferred" });
    const domains = [...publicWebsiteDomains(["linkedin.com", "kununu.com"]), ...(confirmed !== null ? [confirmed] : []), ...(inferred !== null ? [inferred] : [])];
    const args = claudeWebToolArgs(webLimits(domains, 8).allowedDomains).join(" ");
    expect(args).toContain("WebFetch(domain:acme-robotics.com)");
    expect(args).toContain("WebFetch(domain:linkedin.com)");
    expect(args).not.toContain("acme-inferred.com");
  });

  it("the task is one of exactly two web tasks", () => {
    expect([...WEB_ACCESS_TASKS]).toEqual(["salary_lookup", "company_research"]);
    expect(webAccessAllowed("company_research", "claude-cli")).toBe(true);
    expect(webAccessAllowed("company_research", "anthropic")).toBe(true);
    expect(webAccessAllowed("company_research", "deepseek")).toBe(false);
    expect(webAccessAllowed("company_research", "mimo")).toBe(false);
  });

  it("does not use codex-cli unless the user adds it: its search has no domain limit", () => {
    const config = pinnedAi((raw) => {
      delete (raw.tasks as Record<string, unknown>).company_research;
    });
    const order = resolveProviderOrder(config, "company_research");
    expect(order).toEqual(["claude-cli", "anthropic"]);
    expect(order).not.toContain("codex-cli");
  });
});

describe("research.yaml", () => {
  it("the first shipped version is off", () => {
    expect(researchSchema.parse(shippedYaml("research.yaml")).enabled).toBe(false);
  });

  it("may keep a platform on the fetch list without taking it for a company's website", () => {
    const { company } = researchSchema.parse(shippedYaml("research.yaml"));
    expect(company.allowed_domains).toContain("linkedin.com");
    expect(isCompanyWebsiteCandidate("linkedin.com", company.non_company_hosts)).toBe(false);
  });

  it.each(["192.168.1.1", "fritz.box", "printer.local", "co.uk", "*.example-site.com", "--tools"])("refuses %s as an allowed site", (domain) => {
    const raw = shippedYaml("research.yaml") as { company: Record<string, unknown> };
    expect(researchSchema.safeParse({ ...raw, company: { ...raw.company, allowed_domains: [domain] } }).success).toBe(false);
  });
});
