// @vitest-environment node
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAuthFile } from "@/lib/channels/linkedin/session/auth-file";
import { getAppRoot, getDataRoot } from "@/lib/config";
import { resolveExportDir } from "@/lib/resume/paths";

/** JOB_RADAR_DATA_ROOT: where relative user-data paths resolve (a worker in a release directory points it at the checkout). */
afterEach(() => vi.unstubAllEnvs());

describe("getDataRoot", () => {
  it("is the app root when JOB_RADAR_DATA_ROOT is unset or blank", () => {
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "");
    expect(getDataRoot()).toBe(getAppRoot());
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "   ");
    expect(getDataRoot()).toBe(getAppRoot());
  });

  it("is JOB_RADAR_DATA_ROOT when set; a relative value resolves against the app root", () => {
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "/srv/main");
    expect(getDataRoot()).toBe("/srv/main");
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "../main");
    expect(getDataRoot()).toBe(path.resolve(getAppRoot(), "../main"));
  });
});

describe("user-data paths resolve against the data root", () => {
  it("the resume export directory", () => {
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "/srv/main");
    expect(resolveExportDir("data/exports")).toBe("/srv/main/data/exports");
    expect(resolveExportDir("/elsewhere/exports")).toBe("/elsewhere/exports");
  });

  it("the LinkedIn auth file", () => {
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "/srv/main");
    expect(resolveAuthFile(".auth/linkedin.json")).toBe("/srv/main/.auth/linkedin.json");
    expect(resolveAuthFile("/secrets/li.json")).toBe("/secrets/li.json");
  });

  it("both stay under the app root without JOB_RADAR_DATA_ROOT (unchanged behaviour)", () => {
    vi.stubEnv("JOB_RADAR_DATA_ROOT", "");
    expect(resolveExportDir("data/exports")).toBe(path.join(getAppRoot(), "data/exports"));
    expect(resolveAuthFile(".auth/linkedin.json")).toBe(path.join(getAppRoot(), ".auth/linkedin.json"));
  });
});
