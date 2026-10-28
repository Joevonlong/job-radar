// @vitest-environment node
import fs from "node:fs";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setApplicationStatusAction } from "@/app/jobs/[id]/actions";
import { syncSearchLocations } from "@/lib/profile/search-locations";
import { setSourceEnabled } from "@/lib/sources/registry/service";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const db = vi.hoisted(() => ({ getDb: vi.fn() }));
vi.mock("@/lib/db", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/db")>(), ...db }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.stubEnv("JOB_RADAR_LOG_LEVEL", "warn");
});
afterEach(() => {
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
});
