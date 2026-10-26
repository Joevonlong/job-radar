// @vitest-environment node
import { describe, expect, it } from "vitest";

import { CHANNEL_CONFIG_TABLE } from "@/lib/channels/registry";
import { boardEntryId, buildRegistryEntries, CHANNEL_GROUP, parseBoardEntryId } from "@/lib/sources/registry/entries";

import { shippedChannels } from "../channels/helpers";

describe("registry entries", () => {
  it("gives every configured channel a group", () => {
    for (const id of Object.keys(CHANNEL_CONFIG_TABLE)) expect(CHANNEL_GROUP).toHaveProperty([id]);
  });

  it("lists the 21 channels in group order (LinkedIn by cascade first), then the boards in file order", () => {
    const config = shippedChannels();
    const entries = buildRegistryEntries(config);
    const channels = entries.filter((e) => e.type === "channel");
    expect(channels).toHaveLength(21);
    expect(new Set(channels.map((e) => e.id)).size).toBe(21);
    expect(channels.slice(0, config.linkedin.cascade.length).map((e) => e.id)).toEqual([...config.linkedin.cascade]);
    expect(channels[config.linkedin.cascade.length]?.id).toBe("linkedin-session:recommended");
    expect(channels.find((e) => e.id === "arbeitnow")?.group).toBe("job_boards");
    const groups = channels.map((e) => e.group);
    expect(groups).toEqual([...groups].sort((a, b) => ["linkedin", "job_boards", "search_apis", "email", "ats", "discovery"].indexOf(a) - ["linkedin", "job_boards", "search_apis", "email", "ats", "discovery"].indexOf(b)));
    const boards = entries.filter((e) => e.type === "ats_board");
    expect(boards).toHaveLength(config.ats_boards.length);
    expect(boards[0]?.id).toBe(boardEntryId(config.ats_boards[0]?.ats ?? "", config.ats_boards[0]?.token ?? ""));
    expect(boards[0]?.parentId).toBe(config.ats_boards[0]?.ats);
  });

  it("points the switch of every entry at the key it writes", () => {
    const config = shippedChannels();
    const byId = new Map(buildRegistryEntries(config).map((e) => [e.id, e]));
    expect(byId.get("greenhouse")?.enabledPath).toEqual(["sources", "greenhouse", "enabled"]);
    expect(byId.get("gmail-alerts")?.enabledPath).toEqual(["sources", "gmail", "enabled"]);
    expect(byId.get("linkedin-apify")?.enabledPath).toEqual(["linkedin", "apify", "enabled"]);
    expect(byId.get("linkedin-monid")?.enabledPath).toEqual(["linkedin", "monid", "enabled"]);
    expect(byId.get("linkedin-session:recommended")?.enabledPath).toEqual(["linkedin", "session", "recommended_daily"]);
    expect(byId.get("board:greenhouse:zellwerk")?.enabledPath).toEqual(["ats_boards", config.ats_boards.findIndex((b) => b.token === "zellwerk"), "enabled"]);
  });

  it("round-trips board ids, tokens with dots, dashes and capitals included", () => {
    for (const [ats, token] of [["greenhouse", "zellwerk"], ["smartrecruiters", "Heilkraut-Pharmacy"], ["personio", "a.b_c-D"]] as const) {
      expect(parseBoardEntryId(boardEntryId(ats, token))).toEqual({ ats, token });
    }
    expect(parseBoardEntryId("greenhouse")).toBeNull();
    expect(parseBoardEntryId("board:workday:x")).toBeNull();
  });
});
