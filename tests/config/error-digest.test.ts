import { expect, it } from "vitest";
import { CONFIG_NAMES, configRegistry } from "@/lib/config/registry";
import { configErrorDigest, configFileFromDigest } from "@/lib/config/error-digest";

it.each([["jobArchive", "job-archive.yaml"], ["activityLog", "activity-log.yaml"], ["channels", "sources.yaml"], ["ui.yaml", "ui.yaml"]])("maps %s to its configuration filename", (name, file) => {
  expect(configFileFromDigest(configErrorDigest(name))).toBe(file);
});
it("rejects paths and unrelated digests", () => {
  expect(configFileFromDigest(configErrorDigest("../secret"))).toBeNull();
  expect(configFileFromDigest("other:jobArchive")).toBeNull();
});

it.each(CONFIG_NAMES)("the %s error digest resolves to its registry file", (name) => {
  expect(configFileFromDigest(configErrorDigest(name))).toBe(configRegistry[name].file);
});
