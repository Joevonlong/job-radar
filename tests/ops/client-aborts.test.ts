import { describe, expect, it } from "vitest";

import { CLIENT_CLOSED_EARLY_MESSAGE, installClientAbortFilter, isClientAbortLog } from "@/lib/ops/client-aborts";

function fakeConsole() {
  const lines: unknown[][] = [];
  return { lines, error: (...args: unknown[]) => void lines.push(args) };
}

describe("isClientAbortLog", () => {
  it("recognises Next's log line for a client that closed the stream (the prefix is a separate argument)", () => {
    expect(isClientAbortLog(["⨯", new Error(CLIENT_CLOSED_EARLY_MESSAGE)])).toBe(true);
    expect(isClientAbortLog([new Error(CLIENT_CLOSED_EARLY_MESSAGE)])).toBe(true);
  });

  it("does not match other errors, including the other stream error of React's renderer", () => {
    expect(isClientAbortLog(["⨯", new Error("The destination stream errored while writing data.")])).toBe(false);
    expect(isClientAbortLog(["⨯", new Error("connect ECONNREFUSED 127.0.0.1:5433")])).toBe(false);
    expect(isClientAbortLog(["⨯ plain text mentioning the destination stream closed early"])).toBe(false);
    expect(isClientAbortLog([])).toBe(false);
    expect(isClientAbortLog([null, undefined, 3])).toBe(false);
  });
});

describe("installClientAbortFilter", () => {
  it("drops the aborted-stream line and passes everything else on unchanged", () => {
    const target = fakeConsole();
    installClientAbortFilter(target);
    const real = new Error("relation \"jobs\" does not exist");
    target.error("⨯", new Error(CLIENT_CLOSED_EARLY_MESSAGE));
    target.error("⨯", real);
    target.error("plain message", 42);
    expect(target.lines).toEqual([["⨯", real], ["plain message", 42]]);
  });

  it("keeps `this` and is safe to install twice", () => {
    const seen: unknown[] = [];
    const target = {
      error(this: unknown, ...args: unknown[]) {
        seen.push([this, args]);
      },
    };
    installClientAbortFilter(target);
    const second = installClientAbortFilter(target);
    second(); // the second install changed nothing, so restoring it changes nothing
    target.error("x");
    expect(seen).toEqual([[target, ["x"]]]);
  });

  it("restores the original function", () => {
    const target = fakeConsole();
    const original = target.error;
    const restore = installClientAbortFilter(target);
    expect(target.error).not.toBe(original);
    restore();
    expect(target.error).toBe(original);
    target.error("⨯", new Error(CLIENT_CLOSED_EARLY_MESSAGE));
    expect(target.lines).toHaveLength(1);
  });
});
