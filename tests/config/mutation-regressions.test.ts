// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";

import { ensureProfileFiles, getUserConfigPath, hashConfigText, readConfigText, reloadConfig } from "@/lib/config";
import { withFileLock } from "@/lib/config/write";
import { addWatchedCompany } from "@/lib/interests/service";
import { approveSuggestion } from "@/lib/interests/suggestion-apply";
import { syncSearchLocations } from "@/lib/profile/search-locations";
import { configToDraft } from "@/lib/settings/draft";
import { saveSettings } from "@/lib/settings/service";
import { saveWorkflow } from "@/lib/settings/workflow/service";
import { addBoardCandidate } from "@/lib/sources/candidates";
import { applySourcesImport, previewSourcesImport, saveAtsBoard, setSourceEnabled } from "@/lib/sources/registry/service";

import { makeTempConfig, type TempConfig } from "./helpers";

vi.mock("@/lib/db", () => ({
  getDb: () => ({}),
  listBoardCandidates: async () => [{ ats: "ashby", token: "candidate-board", region: null }],
  setBoardCandidateStatus: async () => true,
}));
vi.mock("@/lib/sources/registry/sync", () => ({ syncSourceRegistry: async () => ({ upserted: 0, removed: 0 }) }));
vi.mock("@/lib/profile/snapshots", () => ({ registerProfileSnapshotHook: () => undefined }));
vi.mock("@/lib/signals", () => ({ reconcileBonuses: async () => ({ checked: 0, updated: 0 }) }));
vi.mock("@/lib/db/repos/interest-suggestions", () => ({
  getSuggestion: async () => ({
    status: "pending",
    payloadJson: { kind: "watched_company", company: "Suggested Labs", reasonZh: "理由", reasonEn: "reason", confidence: 0.7, evidence: [{ jobId: 1, title: "Engineer", company: "Suggested Labs" }] },
  }),
  decideSuggestion: async () => ({}),
  reopenSuggestion: async () => undefined,
}));

let tmp: TempConfig;
beforeEach(async () => {
  tmp = makeTempConfig();
  await ensureProfileFiles();
});
afterEach(() => tmp.cleanup());

/** Finish an already queued writer after the service has started, before its own write gets the lock. */
async function behindWriter<T>(file: string, run: () => Promise<T>, finish: () => void = () => undefined): Promise<T> {
  let enter: () => void = () => undefined;
  let release: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => { enter = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writer = withFileLock(file, async () => {
    enter();
    await gate;
    finish();
  });
  await entered;
  const result = run();
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    release();
  }
  await writer;
  return result;
}

function setKey(file: string, key: string[], value: unknown): void {
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  doc.setIn(key, value);
  fs.writeFileSync(file, String(doc));
}

const workflowRequest = { hiddenStatuses: ["preparing"], hiddenWorkplaces: ["onsite"], hiddenContracts: [], interestedDays: "3", appliedDays: "10" };

describe("config mutations keep another writer's changes", () => {
  it("keeps both concurrent source switches", async () => {
    const file = getUserConfigPath("channels");
    setKey(file, ["linkedin", "session", "enabled"], false);
    setKey(file, ["linkedin", "guest", "enabled"], false);
    const results = await Promise.all([
      setSourceEnabled({ id: "linkedin-session", enabled: true, acknowledged: true }),
      setSourceEnabled({ id: "linkedin-guest", enabled: true, acknowledged: true }),
    ]);
    expect(results).toEqual([{ status: "done", outcome: "enabled" }, { status: "done", outcome: "enabled" }]);
    const { linkedin } = reloadConfig("channels");
    expect([linkedin.session.enabled, linkedin.guest.enabled]).toEqual([true, true]);
  });

  it("keeps a candidate and a board added from the registry concurrently", async () => {
    const results = await behindWriter(getUserConfigPath("channels"), () => Promise.all([
      addBoardCandidate({ ats: "ashby", token: "candidate-board" }),
      saveAtsBoard({ original: null, board: { name: "Registry Labs", ats: "ashby", token: "registry-board", enabled: true } }),
    ]));
    expect(results).toEqual([{ status: "done", outcome: "added" }, { status: "done", outcome: "board_added" }]);
    expect(reloadConfig("channels").ats_boards.map((b) => b.token)).toEqual(expect.arrayContaining(["candidate-board", "registry-board"]));
  });

  it("refuses an import when another writer finishes after its preview check", async () => {
    const file = getUserConfigPath("channels");
    setKey(file, ["sources", "indeed", "enabled"], true);
    setKey(file, ["sources", "greenhouse", "enabled"], true);
    const doc = parseDocument(readConfigText("channels"));
    doc.setIn(["sources", "indeed", "enabled"], false);
    const input = { text: String(doc), format: "yaml", mode: "replace" };
    const preview = await previewSourcesImport(input);
    if (preview.status !== "preview") throw new Error("expected an import preview");
    expect(await behindWriter(file, () => applySourcesImport({ ...input, baseHash: preview.baseHash }), () => setKey(file, ["sources", "greenhouse", "enabled"], false))).toEqual({ status: "error", error: "stale" });
    expect(reloadConfig("channels").sources.greenhouse.enabled).toBe(false);
    expect(reloadConfig("channels").sources.indeed.enabled).toBe(true);
  });

  it("syncs locations using the search file after a queued write", async () => {
    const file = getUserConfigPath("search");
    const max = reloadConfig("search").max_per_group_per_location + 1;
    expect(await behindWriter(file, () => syncSearchLocations(["Austin"]), () => setKey(file, ["max_per_group_per_location"], max))).toEqual({ status: "done", locations: ["Austin"] });
    expect(reloadConfig("search")).toMatchObject({ locations: ["Austin"], max_per_group_per_location: max });
  });

  it("keeps unrelated ui settings when the workflow save was queued", async () => {
    const file = getUserConfigPath("ui");
    const max = reloadConfig("ui").filters.company_options_max + 1;
    expect(await behindWriter(file, () => saveWorkflow(workflowRequest), () => setKey(file, ["filters", "company_options_max"], max))).toMatchObject({ status: "saved" });
    expect(reloadConfig("ui").filters).toMatchObject({ company_options_max: max, hidden_workplaces: ["onsite"] });
  });

  it("keeps unrelated notify settings when the workflow's second write was queued", async () => {
    const file = getUserConfigPath("notify");
    const score = reloadConfig("notify").push_min_score - 1;
    expect(await behindWriter(file, () => saveWorkflow(workflowRequest), () => setKey(file, ["push_min_score"], score))).toMatchObject({ status: "saved" });
    expect(reloadConfig("notify")).toMatchObject({ push_min_score: score, reminders: { interested_days: 3, applied_days: 10 } });
  });

  it("keeps a watched company and an approved suggestion from their separate editing paths", async () => {
    const results = await behindWriter(getUserConfigPath("interests"), () => Promise.all([
      addWatchedCompany({ name: "Manual Labs" }), approveSuggestion(1),
    ]));
    expect(results[0]).toMatchObject({ status: "saved" });
    expect(results[1]).toMatchObject({ status: "approved" });
    expect(reloadConfig("interests").watched_companies).toEqual(expect.arrayContaining(["Manual Labs", "Suggested Labs"]));
  });

  it("refuses a salary form made stale by a queued writer", async () => {
    const file = getUserConfigPath("salary");
    const request = { tab: "salary", draft: configToDraft("salary", reloadConfig("salary")), baseHash: hashConfigText(readConfigText("salary")) };
    expect(await behindWriter(file, () => saveSettings(request), () => fs.appendFileSync(file, "\n# saved elsewhere\n"))).toMatchObject({ status: "error", formError: "stale" });
    expect(fs.readFileSync(file, "utf8")).toContain("# saved elsewhere");
  });
});

describe("upgrade freezes reach the caller", () => {
  it("reports frozen before trying to read invalid sources", async () => {
    fs.writeFileSync(getUserConfigPath("channels"), "not: [yaml\n");
    fs.writeFileSync(path.join(tmp.configDir, ".upgrade-freeze"), "frozen");
    expect(await setSourceEnabled({ id: "linkedin-guest", enabled: true, acknowledged: true })).toEqual({ status: "error", error: "frozen" });
  });

  it.each([
    { name: "candidate", run: () => addBoardCandidate({ ats: "ashby", token: "candidate-board" }), expected: { status: "error", error: "frozen" } },
    { name: "locations", run: () => syncSearchLocations(["Austin"]), expected: { status: "error", error: "frozen" } },
    { name: "interests", run: () => addWatchedCompany({ name: "Manual Labs" }), expected: { status: "error", formError: "frozen" } },
    { name: "suggestion", run: () => approveSuggestion(1), expected: { status: "error", error: "frozen" } },
  ])("returns frozen for $name edits", async ({ run, expected }) => {
    fs.writeFileSync(path.join(tmp.configDir, ".upgrade-freeze"), "frozen");
    expect(await run()).toMatchObject(expected);
  });
});
