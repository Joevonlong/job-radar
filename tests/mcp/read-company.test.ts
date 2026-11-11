// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/db/repos/companies", () => ({ getCompanyById: vi.fn() }));
vi.mock("@/lib/db/repos/company-research", () => ({ getCompanyResearchWithJob: vi.fn() }));
vi.mock("@/lib/db/queries/jobs", () => ({ listJobs: vi.fn() }));
vi.mock("@/lib/traps/clean", () => ({ cleanDescriptionStrict: vi.fn() }));
import { companyOverviewDependencies } from "@/lib/companies/overview-data";
import { getCompanyById } from "@/lib/db/repos/companies";
import { getCompanyResearchWithJob } from "@/lib/db/repos/company-research";
import { listJobs } from "@/lib/db/queries/jobs";
import { getCompany } from "@/lib/mcp/tools/get-company";
import { cleanDescriptionStrict } from "@/lib/traps/clean";
import { pipelineWith } from "../pipeline/helpers";
import { BLOCK_NOW } from "./job-block-fixtures";
import { readContext } from "./read-fixtures";

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(companyOverviewDependencies, "loadSettings").mockReturnValue({ pageSize: 20, timezone: "UTC", pipeline: pipelineWith(() => {}), watchedCompanies: [], excludedCompanies: [] });
  vi.mocked(getCompanyById).mockResolvedValue({ id: 3, name: "Ac\u200bme", nameNorm: "acme", atsKind: null, atsToken: null, aliases: ["Alias\u200b", "private@example.invalid"], websiteDomain: "example.invalid", websiteDomainSource: "user", websiteDomainConfirmedAt: BLOCK_NOW, watched: false, blacklisted: false, createdAt: BLOCK_NOW });
  vi.mocked(listJobs).mockResolvedValue({ jobs: [], total: 0, page: 1, pageCount: 1, pageSize: 20 });
  vi.mocked(getCompanyResearchWithJob).mockResolvedValue({
    job: { jobId: 42, description: "Company information" },
    research: { id: 1, companyId: 3, fetchedAt: BLOCK_NOW, expiresAt: null, expired: false, domainUsed: null, provider: null, model: null, fields: { summary: { text: "Derived company summary", sourceUrl: "https://example.invalid/about" } }, dropped: 0 },
  });
});

afterEach(() => vi.restoreAllMocks());

it.each(["not_scanned", "traps_disabled", "settings_unreadable", "findings_unreadable"] as const)("withholds only research text when the scan fails: %s", async (reason) => {
  vi.mocked(cleanDescriptionStrict).mockResolvedValue({ ok: false, reason });
  const result = await getCompany(readContext(), { company_id: 3 });
  expect(result.company).toMatchObject({ name: "Acme", aliases: ["Alias", "[redacted]"], website_domain: "example.invalid", text_withheld: null });
  expect(result.research).toMatchObject({ available: false, reason, fields: [{ field: "summary", text: null, source_url: "https://example.invalid/about" }] });
  expect(cleanDescriptionStrict).toHaveBeenCalledExactlyOnceWith(expect.anything(), { jobId: 42, description: "Company information" }, expect.anything());
});
