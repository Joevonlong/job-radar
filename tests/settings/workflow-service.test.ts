// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse, stringify } from "yaml";

import { reloadConfig } from "@/lib/config";
import { saveWorkflow } from "@/lib/settings/workflow/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => {
  vi.restoreAllMocks();
  tmp.cleanup();
});

const yamlOf = (name: string) => parse(fs.readFileSync(path.join(tmp.configDir, `${name}.yaml`), "utf8")) as Record<string, unknown>;
const request = (over: Record<string, unknown> = {}) => ({
  hiddenStatuses: ["preparing"],
  hiddenWorkplaces: ["onsite"],
  hiddenContracts: [],
  interestedDays: "3",
  appliedDays: "10",
  ...over,
});

describe("saveWorkflow", () => {
  it("writes the hidden lists to ui.yaml and the timeouts to notify.yaml, keeping the rest of both", async () => {
    const before = reloadConfig("notify");
    const result = await saveWorkflow(request());
    expect(result.status).toBe("saved");
    expect(yamlOf("ui")).toMatchObject({ applications: { hidden_statuses: ["preparing"] }, filters: { hidden_workplaces: ["onsite"], hidden_contracts: [] } });
    const notify = reloadConfig("notify");
    expect(notify.reminders).toMatchObject({ interested_days: 3, applied_days: 10, enabled: before.reminders.enabled, max_items: before.reminders.max_items });
    expect(notify.push_min_score).toBe(before.push_min_score);
    // the comments of both files survive
    expect(fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8")).toContain("#");
  });

  it("keeps the other keys of the filters block (the company drop-down) as they were", async () => {
    const file = path.join(tmp.configDir, "ui.yaml");
    const ui = parse(fs.readFileSync(file, "utf8")) as { filters: Record<string, unknown> };
    ui.filters.company_options_max = 123;
    ui.filters.company_options_visible = 7;
    fs.writeFileSync(file, stringify(ui));
    expect((await saveWorkflow(request())).status).toBe("saved");
    expect(yamlOf("ui")).toMatchObject({ filters: { hidden_workplaces: ["onsite"], company_options_max: 123, company_options_visible: 7 } });
  });

  it("validates both files first: a bad timeout writes nothing, not even ui.yaml", async () => {
    const uiBefore = fs.readFileSync(path.join(tmp.configDir, "ui.yaml"), "utf8");
    const notifyBefore = fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8");
    const result = await saveWorkflow(request({ appliedDays: "0", interestedDays: "x" }));
    expect(result).toMatchObject({ status: "error", formError: null });
    if (result.status === "error") {
      const byField = Object.fromEntries(result.fieldErrors.map((error) => [error.field, error.key]));
      expect(byField).toMatchObject({ appliedDays: "greaterThan" });
      expect(Object.keys(byField)).toContain("interestedDays");
    }
    expect(fs.readFileSync(path.join(tmp.configDir, "ui.yaml"), "utf8")).toBe(uiBefore);
    expect(fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8")).toBe(notifyBefore);
  });

  it("refuses to hide new or archived, unknown categories and duplicates", async () => {
    for (const bad of [{ hiddenStatuses: ["new"] }, { hiddenStatuses: ["archived"] }, { hiddenWorkplaces: ["moon"] }, { hiddenContracts: ["student", "nope"] }, { hiddenStatuses: ["applied", "applied"] }]) {
      const result = await saveWorkflow(request(bad));
      expect(result.status, JSON.stringify(bad)).toBe("error");
    }
    expect(yamlOf("ui")).not.toHaveProperty("applications.hidden_statuses.0");
  });

  it("rejects malformed requests", async () => {
    expect(await saveWorkflow({ hiddenStatuses: "preparing" })).toMatchObject({ status: "error", formError: "invalidPayload" });
    expect(await saveWorkflow({ ...request(), extra: 1 })).toMatchObject({ status: "error", formError: "invalidPayload" });
  });

  it("says which file is still old when the second write fails (ui.yaml was written)", async () => {
    const realRename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("notify.yaml")) throw new Error("disk full");
      return realRename(from, to);
    });
    const notifyBefore = fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8");
    const result = await saveWorkflow(request());
    expect(result).toMatchObject({ status: "error", formError: "partial", failedFile: "notify" });
    expect(yamlOf("ui")).toMatchObject({ applications: { hidden_statuses: ["preparing"] } });
    expect(fs.readFileSync(path.join(tmp.configDir, "notify.yaml"), "utf8")).toBe(notifyBefore);
  });

  it("an unreadable ui.yaml is reported, not thrown", async () => {
    fs.writeFileSync(path.join(tmp.configDir, "ui.yaml"), "a: [oops\n");
    expect(await saveWorkflow(request())).toMatchObject({ status: "error", formError: "unreadable" });
  });

  it("an unreadable notify.yaml prevents the first file from being written", async () => {
    const uiBefore = fs.readFileSync(path.join(tmp.configDir, "ui.yaml"), "utf8");
    fs.writeFileSync(path.join(tmp.configDir, "notify.yaml"), "a: [oops\n");
    expect(await saveWorkflow(request())).toMatchObject({ status: "error", formError: "unreadable" });
    expect(fs.readFileSync(path.join(tmp.configDir, "ui.yaml"), "utf8")).toBe(uiBefore);
  });
});
