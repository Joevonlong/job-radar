// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NOW = new Date("2026-10-07T12:00:00Z");
vi.mock("@/lib/db", () => ({
  getDb: () => ({}), getDbNow: async () => new Date("2031-03-02T12:00:00Z"),
  listChannelStates: async () => [], listChannelCycleHistory: async () => new Map(), listRecentRunsByChannel: async () => new Map(),
  getMonthUsage: async () => new Map(), getMonthRunTotals: async () => new Map(), getLatestCycleRuns: async () => null,
  getAiUsageForMonth: async () => [], getLatestHeartbeat: async () => null, getLastAiUsageAt: async () => new Map(),
  getQueryRotationHistory: vi.fn(),
}));
vi.mock("@/lib/db/repos/ai-usage", () => ({ sumAiCostForMonth: async () => 0 }));
vi.mock("@/lib/db/repos/runtime-state", () => ({ getRuntimeState: async () => null }));
vi.mock("@/lib/ai/health", async (original) => ({ ...await original<typeof import("@/lib/ai/health")>(), listProviderHealth: async () => new Map() }));
vi.mock("@/lib/ai/quota-guard", () => ({ createDbQuotaStore: () => ({}), readQuotaStatuses: async () => [] }));
vi.mock("@/lib/ops/ai-worker", () => ({ loadAiWorkerStatus: async () => ({ execution: "host", online: false, lastHeartbeatAt: null, ageSeconds: null, offlineAfterSeconds: 180, queue: { pending: 0, running: 0, oldestPendingAt: null }, lastRun: null }) }));

import { getQueryRotationHistory } from "@/lib/db";
import { resetConfigCache } from "@/lib/config";
import { loadSourcesView } from "@/lib/sources/load";
import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig();
  vi.mocked(getQueryRotationHistory).mockReset();
});
afterEach(() => { temp.cleanup(); vi.restoreAllMocks(); });

describe("sources rotation loading", () => {
  it("keeps the page usable and omits rotation if history cannot be read, without logging the error", async () => {
    vi.mocked(getQueryRotationHistory).mockRejectedValue(new Error("private database details"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = await loadSourcesView(NOW);
    expect(getQueryRotationHistory).toHaveBeenCalledOnce();
    expect(view.cards.length).toBeGreaterThan(0);
    expect(view.cascade.rotation).toBeUndefined();
    expect(view.cards.every((card) => card.rotation === undefined)).toBe(true);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("reads edited search queries and stops reading history when rotation is switched off after the config cache refreshes", async () => {
    vi.mocked(getQueryRotationHistory).mockResolvedValue(new Map());
    await loadSourcesView(NOW);
    const original = vi.mocked(getQueryRotationHistory).mock.calls[0]![1].queryHashes;
    const searchFile = path.join(temp.configDir, "search.yaml");
    const search = parseDocument(fs.readFileSync(searchFile, "utf8"));
    search.set("keyword_groups", { custom: ["designer"] });
    search.set("locations", ["Berlin"]);
    search.set("remote_scope", "none");
    fs.writeFileSync(searchFile, search.toString());
    resetConfigCache();
    const edited = await loadSourcesView(NOW);
    const updated = vi.mocked(getQueryRotationHistory).mock.calls[1]![1].queryHashes;
    expect(updated).toHaveLength(1);
    expect(updated).not.toEqual(original);
    expect(edited.cascade.rotation?.queries).toBe(1);

    const sourceFile = path.join(temp.configDir, "sources.yaml");
    const sources = parseDocument(fs.readFileSync(sourceFile, "utf8"));
    sources.setIn(["collect", "query_rotation"], false);
    fs.writeFileSync(sourceFile, sources.toString());
    resetConfigCache();
    const off = await loadSourcesView(NOW);
    expect(getQueryRotationHistory).toHaveBeenCalledTimes(2);
    expect(off.cascade.rotation).toBeUndefined();
  });

  it("keeps the page usable and omits rotation without reading history when search fails validation", async () => {
    const searchFile = path.join(temp.configDir, "search.yaml");
    const search = parseDocument(fs.readFileSync(searchFile, "utf8"));
    search.set("locations", []);
    fs.writeFileSync(searchFile, search.toString());
    resetConfigCache();

    const view = await loadSourcesView(NOW);
    expect(view.cards.length).toBeGreaterThan(0);
    expect(view.cascade.rotation).toBeUndefined();
    expect(view.cards.every((card) => card.rotation === undefined)).toBe(true);
    expect(getQueryRotationHistory).not.toHaveBeenCalled();
  });

  it("uses the database clock when no time is supplied", async () => {
    vi.mocked(getQueryRotationHistory).mockResolvedValue(new Map());
    const view = await loadSourcesView();
    expect(view.month).toBe("2031-03");
    expect(view.cascade.rotation?.queries).toBeGreaterThan(0);
  });
});
