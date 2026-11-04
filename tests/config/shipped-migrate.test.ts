// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConfigError, currentConfigVersion, reloadConfig, resetConfigCache } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
const shipped = (): string => path.join(temp.defaultsDir, "notify.yaml");

beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("the shipped layer", () => {
  it("newer than the code is an error that names the shipped layer", () => {
    fs.writeFileSync(shipped(), `config_version: ${currentConfigVersion("notify") + 1}\n`);
    fs.writeFileSync(path.join(temp.configDir, "notify.yaml"), `config_version: ${currentConfigVersion("notify")}\n`);
    resetConfigCache();
    try {
      reloadConfig("notify");
      throw new Error("no error");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect(error).toMatchObject({ kind: "version", layer: "shipped" });
    }
  });

  it("older than the code is migrated in memory before the overlay is laid over it", () => {
    const v1 = fs.readFileSync(path.resolve(import.meta.dirname, "../fixtures/config/notify.v1.yaml"), "utf8");
    const value = reloadConfig("notify");
    fs.writeFileSync(shipped(), v1);
    fs.writeFileSync(path.join(temp.configDir, "notify.yaml"), `config_version: ${currentConfigVersion("notify")}\n`);
    resetConfigCache();
    expect(Object.keys(reloadConfig("notify")).sort()).toEqual(Object.keys(value).sort());
  });
});
