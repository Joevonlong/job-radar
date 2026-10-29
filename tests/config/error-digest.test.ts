import { expect, it } from "vitest";
import { CONFIG_NAMES, configRegistry } from "@/lib/config/registry";
import { configErrorDigest, configFileFromDigest } from "@/lib/config/error-digest";

it.each(CONFIG_NAMES)("the %s error digest resolves to its registry file", (name) => {
  expect(configFileFromDigest(configErrorDigest(name))).toBe(configRegistry[name].file);
});
