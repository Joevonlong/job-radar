// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { resolveHostDatabaseUrl } from "@/lib/ops/doctor";
import { cached, extractJson, formatAgo, formatBytes, formatDuration, formatLocal, merge, ratio, redact, worstOf } from "@/lib/ops/doctor/helpers";

import { makeContext } from "./helpers";

describe("formatDuration", () => {
  it("picks a readable unit, in the report's language (the shared format words)", () => {
    const zh = makeContext();
    expect(formatDuration(zh, 0)).toBe("<1 分钟");
    expect(formatDuration(zh, 45)).toBe("45 秒");
    expect(formatDuration(zh, 120)).toBe("2 分钟");
    expect(formatDuration(zh, 3 * 3600)).toBe("3 小时");
    expect(formatDuration(zh, 3 * 86_400)).toBe("3 天");
    expect(formatDuration(zh, -5)).toBe("<1 分钟");
    const en = makeContext({ locale: "en" });
    expect(formatDuration(en, 3 * 3600 + 20 * 60)).toBe("3 h 20 min");
    expect(formatAgo(en, 120)).toBe("2 min ago");
    expect(formatAgo(zh, 120)).toBe("2 分钟前");
  });
  it("formatBytes and formatLocal", () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2 * 1024 ** 3)).toBe("2.0 GB");
    expect(formatBytes(10)).toBe("1 KB");
    expect(formatLocal(new Date("2026-10-07T05:00:00Z"), "Europe/Berlin")).toBe("2026-10-07 07:00");
  });
});

describe("redact", () => {
  it("hides URL credentials and bot tokens (C4)", () => {
    const text = redact("connect postgres://jobradar:s3cret@127.0.0.1:5433/db failed; https://api.telegram.org/bot123456:ABC-def_ghi/getMe; Bearer abc.def");
    expect(text).not.toContain("s3cret");
    expect(text).not.toContain("ABC-def_ghi");
    expect(text).not.toContain("abc.def");
    expect(text).toContain("postgres://***@127.0.0.1:5433/db");
  });
  it("caps the length", () => {
    expect(redact("x".repeat(1000)).length).toBe(300);
  });
});

describe("merge and worstOf", () => {
  const spec = { id: "t", group: "host", title: "t" } as const;
  it("the worst piece decides; hints of non-ok pieces are joined", () => {
    const r = merge(makeContext(), spec, [
      { status: "ok", detail: "a" },
      { status: "warn", detail: "b", hint: "fix b" },
      { status: "fail", detail: "c", hint: "fix c" },
    ]);
    expect(r).toEqual({ ...spec, status: "fail", detail: "a；b；c", hint: "fix b / fix c" });
  });
  it("all ok: no hint", () => {
    expect(merge(makeContext(), spec, [{ status: "ok", detail: "a", hint: "ignored" }])).toEqual({ ...spec, status: "ok", detail: "a" });
    expect(merge(makeContext({ locale: "en" }), spec, [{ status: "ok", detail: "a" }, { status: "ok", detail: "b" }]).detail).toBe("a; b");
  });
  it("worstOf", () => {
    expect(worstOf([])).toBe("ok");
    expect(worstOf(["ok", "warn"])).toBe("warn");
    expect(worstOf(["fail", "warn", "ok"])).toBe("fail");
  });
  it("ratio is null without a limit", () => {
    expect(ratio(1, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });
});

describe("extractJson and cached", () => {
  it("finds the JSON object between warnings", () => {
    expect(extractJson('Warning: x\n{"a":1}\ntrailer')).toEqual({ a: 1 });
    expect(extractJson("no json")).toBeNull();
    expect(extractJson("{broken")).toBeNull();
  });
  it("cached loads once per context and key", async () => {
    const ctx = makeContext();
    const load = vi.fn(async () => 42);
    expect(await Promise.all([cached(ctx, "k", load), cached(ctx, "k", load)])).toEqual([42, 42]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(await cached(makeContext(), "k", async () => 7)).toBe(7);
  });
});

describe("resolveHostDatabaseUrl", () => {
  it("an explicit DATABASE_URL wins", () => {
    expect(resolveHostDatabaseUrl({ DATABASE_URL: "postgres://a:b@h:1/d", POSTGRES_USER: "x" })).toBe("postgres://a:b@h:1/d");
  });
  it("otherwise it follows compose: loopback, DB_HOST_PORT and the POSTGRES_* values", () => {
    expect(resolveHostDatabaseUrl({})).toBe("postgres://jobradar:jobradar@127.0.0.1:5433/jobradar");
    expect(resolveHostDatabaseUrl({ DATABASE_URL: "  ", POSTGRES_USER: "u", POSTGRES_PASSWORD: "p@ss/word", POSTGRES_DB: "db1", DB_HOST_PORT: "5544" })).toBe(
      "postgres://u:p%40ss%2Fword@127.0.0.1:5544/db1",
    );
  });
});
