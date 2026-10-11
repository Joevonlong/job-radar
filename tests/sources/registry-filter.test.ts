// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createLoader } from "nuqs/server";

import { registryParsers } from "@/lib/sources/registry/params";
import { filterRegistryRows } from "@/lib/sources/registry/filter";
import { buildRegistryView } from "@/lib/sources/registry/view";

import { shippedChannels } from "../channels/helpers";
import { boardHealth, cardsFor, NOW, windowStat } from "./registry-helpers";

const config = shippedChannels();
const view = buildRegistryView({
  now: NOW,
  config,
  cards: cardsFor(),
  channelStats: new Map([["indeed", windowStat()]]),
  boardHealth: [boardHealth("greenhouse", "gegensprech", { lastStatus: "error", lastErrorCode: "not_found", consecutiveFailures: 3 }), boardHealth("lever", "pipewerk")],
  boardSeen: new Map(),
});
const base = { type: "all" as const, statuses: [], ats: null, q: "" };

describe("filterRegistryRows", () => {
  it("keeps everything without filters and sorts the boards failing first", () => {
    const rows = filterRegistryRows(view, base);
    expect(rows.channels).toHaveLength(20);
    expect(rows.boards).toHaveLength(config.ats_boards.length);
    expect(rows.boards[0]?.id).toBe("board:greenhouse:gegensprech");
  });

  it("filters by type, by several statuses, by ATS and by text (name, id, token)", () => {
    expect(filterRegistryRows(view, { ...base, type: "channel" }).boards).toEqual([]);
    expect(filterRegistryRows(view, { ...base, type: "ats_board" }).channels).toEqual([]);
    const failing = filterRegistryRows(view, { ...base, statuses: ["failing"] });
    expect(failing.boards.map((b) => b.id)).toEqual(["board:greenhouse:gegensprech"]);
    expect(failing.channels).toEqual([]);
    const both = filterRegistryRows(view, { ...base, statuses: ["failing", "ok"] });
    expect(both.boards.map((b) => b.id)).toEqual(["board:greenhouse:gegensprech", "board:lever:pipewerk"]);
    expect(filterRegistryRows(view, { ...base, ats: "lever" }).boards.every((b) => b.ats === "lever")).toBe(true);
    expect(filterRegistryRows(view, { ...base, ats: "greenhouse" }).channels.map((c) => c.id)).toEqual(["greenhouse"]);
    expect(filterRegistryRows(view, { ...base, q: "  ZELLWERK " }).boards.map((b) => b.token)).toEqual(["zellwerk"]);
    expect(filterRegistryRows(view, { ...base, q: "stepst" }).channels.map((c) => c.id)).toEqual(["stepstone"]);
  });
});

describe("url state", () => {
  const load = createLoader(registryParsers);
  it("reads repeated status keys and drops unknown values", () => {
    expect(load("?type=ats_board&status=failing&status=degraded&status=nope&ats=lever&q=abc")).toEqual({ type: "ats_board", status: ["failing", "degraded"], ats: "lever", q: "abc" });
    expect(load("?type=bogus&ats=workday")).toEqual({ type: "all", status: [], ats: null, q: "" });
  });
});
