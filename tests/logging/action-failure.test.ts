// @vitest-environment node
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { ensureProfileFiles, reloadConfig, setOnProfileSaved } from "@/lib/config";
import { meConfigToDraft } from "@/lib/profile/draft";
import { saveProfile } from "@/lib/profile/service";
import { syncSearchLocations } from "@/lib/profile/search-locations";
import { resetAdvanced, saveAdvanced } from "@/lib/settings/advanced/service";
import { loadAdvancedFile } from "@/lib/settings/advanced/view";
import { setSourceEnabled } from "@/lib/sources/registry/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const db = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/db")>(), ...db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmp: TempConfig;
beforeEach(async () => {
  db.getDb.mockReset();
  tmp = makeTempConfig();
  await ensureProfileFiles();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("JOB_RADAR_LOG_LEVEL", "warn");
});
afterEach(() => {
  setOnProfileSaved(null);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tmp.cleanup();
});

describe("caught action failures are diagnosable without private details", () => {
  it.each(["EACCES", "42P01"])("logs %s from an action without the error message, stack or connection string", async (code) => {
    const cause = Object.assign(new Error("postgres://private-user:private-password@private-host/private-db"), { code });
    const error = new Error("query and private payload", { cause });
    error.name = "QueryError";
    db.getDb.mockImplementation(() => { throw error; });
    expect(await setApplicationStatusAction({ jobId: 1, status: "interested" })).toEqual({ ok: false, error: "failed" });
    const lines = vi.mocked(console.warn).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain("setApplicationStatusAction");
    expect(lines).toContain("QueryError");
    expect(lines).toContain(code);
    expect(lines).not.toMatch(/private|payload|postgres:\/\/|query and/);
  });

  it("logs a refused filesystem write at the service that returns the friendly result", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("/private/config/search.yaml contains private form data"), { code: "EACCES" });
    });
    expect(await syncSearchLocations(["Austin"])).toEqual({ status: "error", error: "write_failed" });
    const lines = vi.mocked(console.warn).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain("syncSearchLocations");
    expect(lines).toContain("EACCES");
    expect(lines).not.toContain("/private/config");
    expect(lines).not.toContain("private form data");
  });

  it("names the source switch that failed inside the shared config helper", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw Object.assign(new Error("private path and content"), { code: "EACCES" });
    });
    expect(await setSourceEnabled({ id: "indeed", enabled: false })).toEqual({ status: "error", error: "write_failed" });
    const lines = vi.mocked(console.warn).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain("setSourceEnabled");
    expect(lines).toContain("EACCES");
    expect(lines).not.toContain("private path and content");
  });

  it.each(["saveAdvanced", "resetAdvanced", "saveProfile"] as const)("logs a converted EACCES from %s without leaking paths, payloads or credentials", async (action) => {
    const loaded = loadAdvancedFile("notify");
    if (!loaded.ok) throw new Error("expected editable fixture");
    const draft = meConfigToDraft(reloadConfig("me"));
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const error = Object.assign(new Error("/private/config contains private form data postgres://private-user:private-password@private-host/private-db"), { code: "EACCES" });
      error.stack = "private stack with payload";
      throw error;
    });
    if (action === "saveAdvanced") {
      expect(await saveAdvanced({ file: "notify", text: `${loaded.data.text}\n# edit\n`, baseHash: loaded.data.hash, baseLayer: loaded.data.layer, confirmOverride: false })).toEqual({ status: "failed" });
    } else if (action === "resetAdvanced") {
      expect(await resetAdvanced({ file: "notify", baseHash: loaded.data.hash, baseLayer: loaded.data.layer })).toEqual({ status: "failed" });
    } else {
      expect(await saveProfile("me", draft)).toMatchObject({ status: "error", formError: "writeFailed" });
    }
    const lines = vi.mocked(console.warn).mock.calls.map((call) => call.join(" ")).join("\n");
    expect(lines).toContain(action);
    expect(lines).toContain("EACCES");
    expect(lines).not.toMatch(/private|payload|postgres:\/\/|stack/);
  });
});
