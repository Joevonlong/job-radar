// @vitest-environment node
import { describe, expect, it } from "vitest";

import { SkipCheck } from "@/lib/ops/doctor";
import { sourcesRegistryCheck } from "@/lib/ops/doctor/checks/sources";
import { buildRegistryView } from "@/lib/sources/registry/view";
import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../../config/helpers";
import { boardHealth } from "../../sources/registry-helpers";
import { makeContext, NOW, only, registryData, results, sourcesView } from "./helpers";

const withRegistry = (data = registryData()) => makeContext({ probes: { registry: async () => data } });

describe("sources.registry", () => {
  it("is ok for a healthy registry and counts the states", async () => {
    const [result] = await results(sourcesRegistryCheck, withRegistry());
    expect(result).toMatchObject({ id: "sources.registry", group: "channels", status: "ok" });
    expect(result?.detail).toContain("个来源：");
  });

  it("fails with the path and reason of an unreadable file, never its contents", async () => {
    const result = await only(sourcesRegistryCheck, withRegistry(registryData({ file: { mode: "current", label: "data/config/sources.yaml", invalid: [{ path: "sources.indeed.max_results", message: "must be positive" }] } })));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("sources.indeed.max_results: must be positive");
  });

  it("warns about a mirror that is behind", async () => {
    const result = await only(sourcesRegistryCheck, withRegistry(registryData({ file: { mode: "current", label: "data/config/sources.yaml", invalid: null }, mirror: { syncedAt: null, inSync: false } })));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("镜像");
  });

  it("warns about enabled sources that fail, listing ids", async () => {
    const config = configRegistry.channels.schema.parse(structuredClone(shippedYaml("sources.yaml")));
    const failing = boardHealth("greenhouse", "zellwerk", { lastStatus: "error", lastErrorCode: "not_found", consecutiveFailures: 3 });
    const view = buildRegistryView({ now: NOW, config, cards: sourcesView().cards, channelStats: new Map(), boardHealth: [failing], boardSeen: new Map() });
    const result = await only(sourcesRegistryCheck, withRegistry(registryData({ view })));
    expect(result.status).toBe("warn");
    expect(result.detail).toContain("board:greenhouse:zellwerk");
    expect(result.hint).toContain("pnpm sources:list --status failing");
  });

  it("is skipped when the database cannot be reached", async () => {
    await expect(sourcesRegistryCheck.run(makeContext({ probes: { dbPing: async () => false } }))).rejects.toBeInstanceOf(SkipCheck);
  });
});
