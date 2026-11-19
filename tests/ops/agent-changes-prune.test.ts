// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createAgentChangesPruner } from "@/runner/agent-changes-prune";

const DAY_MS = 24 * 60 * 60 * 1000;

function fixture() {
  let now = 0;
  const settings = { sync: { retention_days: 10, max_batch: 50 } };
  const deps = {
    now: () => now,
    loadConfig: vi.fn(() => settings),
    prune: vi.fn<(retentionDays: number) => Promise<number>>(async () => 2),
    log: vi.fn(),
  };
  return { deps, settings, service: createAgentChangesPruner(deps), advance: (ms: number) => { now += ms; } };
}

describe("runner change log pruning", () => {
  it("runs immediately, then once each day with the current retention", async () => {
    const { deps, settings, service, advance } = fixture();
    await service.tick();
    expect(deps.prune).toHaveBeenCalledExactlyOnceWith(10);
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("pruned 2 agent changes");

    advance(DAY_MS - 1);
    await service.tick();
    expect(deps.loadConfig).toHaveBeenCalledTimes(1);
    advance(1);
    settings.sync.retention_days = 20;
    await service.tick();
    expect(deps.prune).toHaveBeenLastCalledWith(20);
  });

  it("does not overlap an unfinished prune or log an empty deletion", async () => {
    const { deps, service, advance } = fixture();
    const gate = Promise.withResolvers<number>();
    deps.prune.mockReturnValueOnce(gate.promise);
    const first = service.tick();
    advance(DAY_MS);
    const next = service.tick();
    expect(deps.prune).toHaveBeenCalledTimes(1);
    gate.resolve(0);
    await Promise.all([first, next]);
    expect(deps.log).not.toHaveBeenCalled();
  });

  it.each(["loadConfig", "prune"] as const)("contains %s failures and retries the next day", async (failure) => {
    const { deps, service, advance } = fixture();
    deps[failure].mockImplementationOnce(() => { throw new Error("private details"); });
    await expect(service.tick()).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith("agent change log prune failed");
    await service.tick();
    expect(deps.loadConfig).toHaveBeenCalledTimes(1);

    advance(DAY_MS);
    await service.tick();
    expect(deps.log).toHaveBeenLastCalledWith("pruned 2 agent changes");
  });
});
