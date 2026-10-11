// @vitest-environment node
import { describe, expect, it } from "vitest";

import { DOCKER_DEFAULT_DATA_DIR, resolveDockerDataLocation } from "@/lib/ops/docker-data";

const HOME = "/Users/test";
const SETTINGS = `${HOME}/Library/Group Containers/group.com.docker`;

/** A fake file system: path -> content; anything else is missing. */
const files = (map: Record<string, string>) => async (file: string): Promise<string> => {
  const content = map[file];
  if (content === undefined) throw Object.assign(new Error(`ENOENT: ${file}`), { code: "ENOENT" });
  return content;
};

const resolve = (map: Record<string, string>, platform: NodeJS.Platform = "darwin") => resolveDockerDataLocation({ homeDir: HOME, platform, readText: files(map) });

describe("resolveDockerDataLocation", () => {
  it("reads DataFolder from settings-store.json (the moved disk image on the SSD)", async () => {
    const store = JSON.stringify({ DataFolder: "/Volumes/Data/.docker-data", DiskSizeMiB: 61035, OtherSetting: true });
    expect(await resolve({ [`${SETTINGS}/settings-store.json`]: store })).toEqual({ path: "/Volumes/Data/.docker-data", source: "settings-store" });
  });

  it("falls back to dataFolder in the older settings.json", async () => {
    const legacy = JSON.stringify({ dataFolder: "/Volumes/Other/docker" });
    expect(await resolve({ [`${SETTINGS}/settings-store.json`]: "{}", [`${SETTINGS}/settings.json`]: legacy })).toEqual({ path: "/Volumes/Other/docker", source: "settings" });
  });

  it("falls back to the default location when no settings file is readable or usable", async () => {
    const fallback = { path: `${HOME}/${DOCKER_DEFAULT_DATA_DIR}`, source: "default" };
    expect(await resolve({})).toEqual(fallback);
    expect(await resolve({ [`${SETTINGS}/settings-store.json`]: "not json{" })).toEqual(fallback);
    expect(await resolve({ [`${SETTINGS}/settings-store.json`]: JSON.stringify({ DataFolder: "" }) })).toEqual(fallback);
    expect(await resolve({ [`${SETTINGS}/settings-store.json`]: JSON.stringify({ DataFolder: "relative/path" }) })).toEqual(fallback);
    expect(await resolve({ [`${SETTINGS}/settings-store.json`]: JSON.stringify({ DataFolder: 42 }) })).toEqual(fallback);
  });

  it("is the home directory off macOS", async () => {
    expect(await resolve({}, "linux")).toEqual({ path: HOME, source: "home" });
  });

  it("normalises the folder path", async () => {
    const store = JSON.stringify({ DataFolder: "/Volumes/Data/.docker-data/" });
    expect((await resolve({ [`${SETTINGS}/settings-store.json`]: store })).path).toBe("/Volumes/Data/.docker-data/");
    const messy = JSON.stringify({ DataFolder: "/Volumes/Data//x/../.docker-data" });
    expect((await resolve({ [`${SETTINGS}/settings-store.json`]: messy })).path).toBe("/Volumes/Data/.docker-data");
  });
});
