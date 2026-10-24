import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig, writeConfig } from "@/lib/config";
import { removeWatchedCompanies } from "@/lib/interests/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let temp: TempConfig;
beforeEach(async () => {
  temp = makeTempConfig();
  await writeConfig("interests", { ...loadConfig("interests"), watched_companies: ["Acme", "Acme GmbH", "Other"] });
});
afterEach(() => temp.cleanup());

describe("remove watched companies", () => {
  it("removes every named entry and keeps other entries and settings", async () => {
    const before = loadConfig("interests");
    expect(await removeWatchedCompanies({ names: ["Acme", "Acme GmbH", "Missing"] })).toMatchObject({ status: "saved", section: "watched" });
    expect(loadConfig("interests")).toEqual({ ...before, watched_companies: ["Other"] });
  });

  it("preserves concurrent removals from the same watch list", async () => {
    const results = await Promise.all([
      removeWatchedCompanies({ names: ["Acme", "Acme GmbH"] }),
      removeWatchedCompanies({ names: ["Other"] }),
    ]);
    for (const result of results) expect(result).toMatchObject({ status: "saved" });
    expect(loadConfig("interests").watched_companies).toEqual([]);
  });

  it("returns watchedNotFound when none of the exact strings are present", async () => {
    expect(await removeWatchedCompanies({ names: ["ACME", "Missing"] })).toMatchObject({ status: "error", formError: "watchedNotFound" });
    expect(loadConfig("interests").watched_companies).toEqual(["Acme", "Acme GmbH", "Other"]);
  });

  it.each([null, {}, { names: [] }, { names: "Acme" }, { names: [1] }, { names: ["Acme"], extra: true }, { names: Array.from({ length: 1001 }, () => "Acme") }])("rejects an invalid payload (%#) without editing the list", async (request) => {
    expect(await removeWatchedCompanies(request)).toMatchObject({ status: "error", formError: "invalidPayload" });
    expect(loadConfig("interests").watched_companies).toEqual(["Acme", "Acme GmbH", "Other"]);
  });
});
