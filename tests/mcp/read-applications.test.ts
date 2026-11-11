// @vitest-environment node
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/db/queries/pipeline", () => ({ listPipelineEntries: vi.fn() }));
vi.mock("@/lib/traps/clean", () => ({ cleanDescriptionStrict: vi.fn() }));
import { listPipelineEntries, type PipelineEntry } from "@/lib/db/queries/pipeline";
import { toApplicationItemDto } from "@/lib/mcp/dto/tracking";
import { shortFieldCleaner } from "@/lib/mcp/guard";
import { listApplications } from "@/lib/mcp/tools/list-applications";
import { readCards } from "@/lib/mcp/tools/read-shared";
import { cleanDescriptionStrict } from "@/lib/traps/clean";
import { blockDetail } from "./job-block-fixtures";
import { readContext } from "./read-fixtures";

function application(): PipelineEntry {
  const detail = blockDetail();
  return {
    job: { ...detail, title: "Data\u200b Engineer", companyId: detail.company.id, companyName: "Ac\u200bme", closedReason: null, linkCheck: null, applicationStatus: "applied", rank: detail.score, summary: null, seen: false, ghost: null, visa: null,
      sources: [{ channelId: "fixture", family: "ats", url: "https://example.invalid/job", applyUrl: "https://example.invalid/apply", priority: 1 }],
      locations: [{ label: "Example\u200b City", city: "Example\u200b City", countryCode: "D\u200bE", isPrimary: true }],
    },
    application: detail.application!, events: detail.applicationEvents,
  };
}
beforeEach(() => vi.resetAllMocks());

it.each(["not_scanned", "rules_stale", "disabled"] as const)("matches the main mapping without notes when scans are %s", async (reason) => {
  const ctx = readContext();
  const entry = application();
  vi.mocked(listPipelineEntries).mockResolvedValue([entry]);
  vi.mocked(cleanDescriptionStrict).mockResolvedValue({ ok: false, reason: reason === "disabled" ? "traps_disabled" : "not_scanned" });
  if (reason === "disabled") {
    const settings = { ...ctx.traps(), enabled: false };
    ctx.traps = () => settings;
  }
  const expected = toApplicationItemDto(entry, ctx.now(), shortFieldCleaner(ctx.traps()));
  expect(await listApplications(ctx, {})).toEqual({ notices: [ctx.text("notice.thirdParty")], total: 1, returned: 1, truncated: false, applications: [expected] });
  expect(expected).toMatchObject({ title: "Data Engineer", company: "Acme", links: [{ source: "ats", url: "https://example.invalid/job", apply_url: "https://example.invalid/apply" }] });
  expect(cleanDescriptionStrict).not.toHaveBeenCalled();
});

it("cleans card facts and links without touching scans or posting text", async () => {
  const ctx = readContext();
  ctx.db = new Proxy(ctx.db, { get() { throw new Error("unexpected database access"); } });
  const entry = application();
  entry.job.title = "Engineer private@example.invalid";
  entry.job.sources[0]!.family = "a\u200bts";
  entry.job.sources[0]!.applyUrl = "https://example.invalid/apply?access_key=sample";
  const [card] = await readCards(ctx, [entry.job]);
  expect(card).toMatchObject({ title: "Engineer [redacted]", company: "Acme", locations: [{ label: "Example City", city: "Example City", country_code: "DE" }], links: [{ source: "ats", url: "https://example.invalid/job", apply_url: null }], text_withheld: null });
  expect(cleanDescriptionStrict).not.toHaveBeenCalled();
});
