// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Where the processes report their shipped config. The loops live inline in each entry point's `main()`, so these are
 * structural checks of the source: removing a call (or moving it out of its loop) fails here.
 */
const ROOT = path.resolve(import.meta.dirname, "../..");

/** The source without comments, so a call that is only mentioned in a comment does not count. */
function code(relative: string): string {
  return fs
    .readFileSync(path.join(ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** The text from `start` up to the first `end` after it (both must exist). */
function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from, `missing: ${start}`).toBeGreaterThanOrEqual(0);
  const to = source.indexOf(end, from + start.length);
  expect(to, `missing after ${start}: ${end}`).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("shipped config report call sites", () => {
  it("runner: reports at start-up and in every heartbeat iteration", () => {
    const source = code("src/runner/index.ts");
    expect(source).toMatch(/createShippedConfigReporter\(\{\s*process: "runner",/);
    // start-up: before the channels are registered
    expect(between(source, "createShippedConfigReporter(", "registerBuiltinChannels(")).toContain("await shippedConfig.report();");
    // the heartbeat loop: after the heartbeat write, before the sleep, inside the same loop
    const loop = between(source, "while (!abort.signal.aborted) {\n    try {\n      await writeHeartbeat(db, PROCESS_NAME);", "await sleep(intervalMs");
    expect(loop).toContain("await shippedConfig.report();");
  });

  it("ai-worker: reports in every heartbeat iteration", () => {
    const source = code("src/ai-worker/index.ts");
    expect(source).toMatch(/createShippedConfigReporter\(\{\s*process: "ai-worker",/);
    const loop = between(source, "await withTimeout(writeHeartbeat(db, HEARTBEAT_PROCESS.aiWorker)", "lock.check()");
    expect(loop).toContain("await shippedConfig.report();");
    expect(between(source, "const heartbeats = (async", "await withTimeout(writeHeartbeat(db, HEARTBEAT_PROCESS.aiWorker)")).toContain("while (!abort.signal.aborted) {");
  });

  it("web: reports at start-up and retries on each health check with a reachable database", () => {
    expect(code("src/instrumentation.ts")).toContain("void reportWebShippedConfig();");
    const health = code("src/app/api/health/route.ts");
    expect(between(health, "if (dbOk) {", "} catch")).toContain("void reportWebShippedConfig();");
  });
});
