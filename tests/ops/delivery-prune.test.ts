// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createDeliveryPruner } from "@/runner/delivery-prune";

function fixture() {
  let time = new Date("2026-10-20T12:00:00Z");
  const config = { retention: { days: 1, warn_bytes: 100 }, prune: { every_minutes: 10, batch_size: 2, statement_timeout_ms: 50 } };
  const deps = {
    now: () => time,
    loadConfig: vi.fn(() => config),
    tablesReady: vi.fn(async () => true),
    payloadBytes: vi.fn(async () => 0),
    prune: vi.fn(async () => 2),
    log: vi.fn(),
  };
  return { deps, config, service: createDeliveryPruner(deps), advance: (ms: number) => { time = new Date(time.getTime() + ms); } };
}

describe("delivery pruning", () => {
  it("only starts background maintenance for cycles that actually collected", async () => {
    const { service, deps } = fixture();
    service.afterCycle({ dryRun: false, steps: [{ name: "collect", status: "skipped" }] });
    service.afterCycle({ dryRun: true, steps: [{ name: "collect", status: "ok" }] });
    await service.tick();
    expect(deps.payloadBytes).not.toHaveBeenCalled();
    service.afterCycle({ dryRun: false, steps: [{ name: "collect", status: "failed" }] });
    await vi.waitFor(() => expect(deps.payloadBytes).toHaveBeenCalledTimes(1));
  });
  it("runs on its own interval with a fresh config and an age cutoff", async () => {
    const { service, deps, advance, config } = fixture();
    await service.tick();
    expect(deps.prune).toHaveBeenCalledExactlyOnceWith({ olderThan: new Date("2026-10-19T12:00:00Z"), batchSize: 2, statementTimeoutMs: 50 });
    advance(9 * 60_000);
    await service.tick();
    expect(deps.prune).toHaveBeenCalledTimes(1);
    config.retention.days = 2;
    advance(60_000);
    await service.tick();
    expect(deps.prune).toHaveBeenLastCalledWith({ olderThan: new Date("2026-10-18T12:10:00Z"), batchSize: 2, statementTimeoutMs: 50 });
  });

  it("prunes early only above the byte threshold and resets the interval", async () => {
    const { service, deps, advance } = fixture();
    await service.tick();
    deps.payloadBytes.mockResolvedValue(100);
    await service.afterCollect();
    expect(deps.prune).toHaveBeenCalledTimes(1);
    advance(60_000);
    deps.payloadBytes.mockResolvedValue(101);
    await service.afterCollect();
    expect(deps.prune).toHaveBeenCalledTimes(2);
    advance(9 * 60_000);
    await service.tick();
    expect(deps.prune).toHaveBeenCalledTimes(2);
  });

  it("silently skips missing tables and zero deletions", async () => {
    const { service, deps } = fixture();
    deps.tablesReady.mockResolvedValue(false);
    await service.tick();
    await service.afterCollect();
    expect(deps.prune).not.toHaveBeenCalled();
    expect(deps.payloadBytes).not.toHaveBeenCalled();
    deps.tablesReady.mockResolvedValue(true);
    deps.prune.mockResolvedValue(0);
    await service.afterCollect();
    await service.tick();
    expect(deps.log).not.toHaveBeenCalled();
  });

  it.each(["loadConfig", "tablesReady", "payloadBytes", "prune"] as const)("contains %s failures without exposing their message", async (failure) => {
    const { service, deps } = fixture();
    deps.payloadBytes.mockResolvedValue(101);
    deps[failure].mockImplementation(() => { throw new Error("private payload or external id"); });
    await expect(service.afterCollect()).resolves.toBeUndefined();
    await expect(service.tick()).resolves.toBeUndefined();
    expect(JSON.stringify(deps.log.mock.calls)).not.toContain("private");
  });

  it("serializes periodic and post-collect work", async () => {
    const { service, deps } = fixture();
    const gate = Promise.withResolvers<number>();
    deps.prune.mockImplementationOnce(() => gate.promise);
    deps.payloadBytes.mockResolvedValue(101);
    const tick = service.tick();
    const collect = service.afterCollect();
    await vi.waitFor(() => expect(deps.prune).toHaveBeenCalledTimes(1));
    expect(deps.payloadBytes).not.toHaveBeenCalled();
    gate.resolve(1);
    await Promise.all([tick, collect]);
    expect(deps.prune).toHaveBeenCalledTimes(2);
  });
});
