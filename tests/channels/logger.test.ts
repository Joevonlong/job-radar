// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createLogger, redactFields, safeUrl, type LogRecord } from "@/lib/channels/logger";

describe("logger", () => {
  it("redacts sensitive keys, at any depth", () => {
    const out = redactFields({
      channel: "x",
      authorization: "Bearer abc",
      Cookie: "li_at=abc",
      nested: { apiKey: "k", token: "t", ok: 1 },
      headers: { a: "b" },
    });
    expect(out).toEqual({
      channel: "x",
      authorization: "[redacted]",
      Cookie: "[redacted]",
      nested: { apiKey: "[redacted]", token: "[redacted]", ok: 1 },
      headers: "[redacted]",
    });
  });

  it("shortens long strings and serialises errors without stack traces", () => {
    const out = redactFields({ long: "x".repeat(1000), error: new Error("boom") });
    expect(String(out.long).length).toBeLessThan(400);
    expect(out.error).toBe("Error: boom");
  });

  it("filters by level and merges child fields", () => {
    const records: LogRecord[] = [];
    const logger = createLogger({ sink: (r) => records.push(r), minLevel: "warn", now: () => new Date(0) });
    const child = logger.child({ channel: "fixture" });
    child.info("hidden");
    child.warn("shown", { code: "blocked" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ level: "warn", message: "shown", fields: { channel: "fixture", code: "blocked" } });
  });

  it("strips query strings and fragments from URLs", () => {
    expect(safeUrl("https://a.example.test/p/q?token=abc#frag")).toBe("https://a.example.test/p/q");
    expect(safeUrl("not a url")).toBe("[invalid-url]");
  });
});
