// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/config", () => ({ loadConfig: vi.fn(), reloadConfig: vi.fn() }));
vi.mock("@/lib/dashboard/deal-breakers", () => ({ loadDealBreakerNotice: vi.fn() }));
vi.mock("@/lib/dashboard/german", () => ({ userGermanLabelOrNull: vi.fn() }));
vi.mock("@/lib/ghost/settings", () => ({ ghostEnabled: vi.fn() }));
vi.mock("@/lib/market", () => ({ loadPipeline: vi.fn() }));
vi.mock("@/lib/salary/settings", () => ({ readSalarySettings: vi.fn() }));
vi.mock("@/lib/signals/floor", () => ({ loadBaseCurrency: vi.fn(), loadSalaryFloor: vi.fn() }));
vi.mock("@/lib/visa/settings", () => ({ readNeedsVisaSponsorship: vi.fn(), visaEnabled: vi.fn() }));

import { loadConfig, reloadConfig } from "@/lib/config";
import { loadDealBreakerNotice } from "@/lib/dashboard/deal-breakers";
import { userGermanLabelOrNull } from "@/lib/dashboard/german";
import { ghostEnabled } from "@/lib/ghost/settings";
import { loadPipeline } from "@/lib/market";
import { jobBlockSettings } from "@/lib/mcp/job-blocks/settings";
import { readSalarySettings } from "@/lib/salary/settings";
import { loadBaseCurrency, loadSalaryFloor } from "@/lib/signals/floor";
import { readNeedsVisaSponsorship, visaEnabled } from "@/lib/visa/settings";

import { blockDetail } from "./job-block-fixtures";

const reads = [loadConfig, reloadConfig, loadDealBreakerNotice, userGermanLabelOrNull, ghostEnabled, loadPipeline, readSalarySettings, loadBaseCurrency, loadSalaryFloor, readNeedsVisaSponsorship, visaEnabled];

beforeEach(() => {
  vi.resetAllMocks();
  for (const read of reads) vi.mocked(read).mockImplementation(() => { throw new Error("unreadable input"); });
});

describe("job block settings", () => {
  it("reads nothing until requested and returns unset values when each configuration read throws", () => {
    const settings = jobBlockSettings();
    for (const read of reads) expect(read).not.toHaveBeenCalled();
    expect(settings.ghostEnabled()).toBe(false);
    expect(settings.visaEnabled()).toBe(false);
    expect(settings.needsVisaSponsorship()).toBe(false);
    expect(settings.salary()).toBeNull();
    expect(settings.ai()).toBeNull();
    expect(settings.skills()).toEqual([]);
    expect(settings.skillAliases()).toEqual([]);
    expect(settings.germanLabel()).toBeNull();
    expect(settings.salaryFloor()).toBeNull();
    expect(settings.baseCurrency()).toBeNull();
    expect(settings.dealBreakers(blockDetail(), ["deal_breaker:rule"])).toBeUndefined();
  });

  it("evaluates and caches only the requested reader, including its failure", () => {
    vi.mocked(loadBaseCurrency).mockReturnValue("USD");
    const settings = jobBlockSettings();
    expect(settings.baseCurrency()).toBe("USD");
    expect(settings.baseCurrency()).toBe("USD");
    expect(loadBaseCurrency).toHaveBeenCalledTimes(1);
    expect(settings.skills()).toEqual([]);
    expect(settings.skills()).toEqual([]);
    expect(loadConfig).toHaveBeenCalledTimes(1);
    expect(loadPipeline).not.toHaveBeenCalled();
    expect(reloadConfig).not.toHaveBeenCalled();
  });
});
