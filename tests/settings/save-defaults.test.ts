// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { hashConfigText, loadConfig, readConfigText, resetConfigCache } from "@/lib/config";
import { configToDraft } from "@/lib/settings/draft";
import { saveSettings } from "@/lib/settings/service";
import { SETTINGS_FILES, SETTINGS_FORMS } from "@/lib/settings/tabs";

import { makeTempConfig, type TempConfig } from "../config/helpers";

let tmp: TempConfig;
afterEach(() => tmp.cleanup());

/** Every key path of a parsed YAML value (maps only; a list is one leaf), `config_version` left out. */
function keyPaths(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => (prefix === "" && key === "config_version" ? [] : [`${prefix}${key}`, ...keyPaths(child, `${prefix}${key}.`)]));
}

const yamlOf = (file: string): unknown => parse(fs.readFileSync(file, "utf8"));

describe("a settings save writes no factory defaults into the user config", () => {
  for (const user of ["empty", "init"] as const) {
    describe(`user directory: ${user}`, () => {
      beforeEach(() => {
        tmp = makeTempConfig({ user });
        resetConfigCache();
      });

      it.each(SETTINGS_FORMS)("%s: saving the form as it is adds no key the file did not have", async (tab) => {
        const file = SETTINGS_FILES[tab];
        const before = keyPaths(yamlOf(fs.existsSync(path.join(tmp.configDir, file)) ? path.join(tmp.configDir, file) : path.join(tmp.defaultsDir, file)));
        const state = await saveSettings({ tab, draft: configToDraft(tab, loadConfig(tab)), baseHash: hashConfigText(readConfigText(tab)) });
        expect(state.status).toBe("saved");
        const after = keyPaths(yamlOf(path.join(tmp.configDir, file)));
        expect(after.filter((key) => !before.includes(key))).toEqual([]);
        expect(fs.statSync(path.join(tmp.configDir, file)).mode & 0o777).toBe(0o600);
      });
    });
  }
});
