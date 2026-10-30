import { describe, expect, it } from "vitest";

import { NAV_ITEMS, PALETTE_SUBPAGES, groupNavItems, isNavActive } from "@/components/shell/nav";
import zh from "../messages/zh.json";

describe("nav config", () => {
  it("has the 10 expected entries in order", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/",
      "/jobs",
      "/companies",
      "/favorites",
      "/pipeline",
      "/sources",
      "/insights",
      "/settings",
      "/me",
      "/interests",
    ]);
  });

  it("has unique keys and hrefs, absolute hrefs and an icon each", () => {
    expect(new Set(NAV_ITEMS.map((i) => i.key)).size).toBe(NAV_ITEMS.length);
    expect(new Set(NAV_ITEMS.map((i) => i.href)).size).toBe(NAV_ITEMS.length);
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith("/")).toBe(true);
      expect(item.icon).toBeTruthy();
    }
  });

  it("has a nav label and a page title/description in messages for every item", () => {
    for (const item of NAV_ITEMS) {
      expect(zh.nav[item.key]).toBeTruthy();
      expect(zh.pages[item.key].title).toBeTruthy();
      expect(zh.pages[item.key].description).toBeTruthy();
    }
  });
});

describe("palette subpages", () => {
  it("lists thirteen destinations including activity logs without changing main navigation", () => {
    expect(NAV_ITEMS.length + PALETTE_SUBPAGES.length).toBe(13);
    expect(PALETTE_SUBPAGES.find((page) => page.key === "logs")?.href).toBe("/sources/logs");
    expect(zh.sources.subnav.logs).toBe("操作日志");
    expect(zh.sources.subnav.logsKeywords).toContain("logs");
    expect(zh.sources.subnav.logsKeywords).toContain("日志");
  });
});

describe("nav groups", () => {
  it("puts the last three items under the settings group and keeps the overall order", () => {
    const groups = groupNavItems();
    expect(groups.map((g) => g.group)).toEqual(["main", "settings"]);
    expect(groups[0]?.items.map((i) => i.href)).toEqual(["/", "/jobs", "/companies", "/favorites", "/pipeline", "/sources", "/insights"]);
    expect(groups[1]?.items.map((i) => i.href)).toEqual(["/settings", "/me", "/interests"]);
    expect(groups.flatMap((g) => g.items)).toEqual([...NAV_ITEMS]);
  });
});

describe("isNavActive", () => {
  it("matches / only exactly", () => {
    expect(isNavActive("/", "/")).toBe(true);
    expect(isNavActive("/jobs", "/")).toBe(false);
  });

  it("matches sub-routes of other items", () => {
    expect(isNavActive("/jobs", "/jobs")).toBe(true);
    expect(isNavActive("/jobs/42", "/jobs")).toBe(true);
    expect(isNavActive("/jobsx", "/jobs")).toBe(false);
    expect(isNavActive("/pipeline", "/jobs")).toBe(false);
  });
});
