// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { layeredConfigFingerprint, layeredFingerprint } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let temp: TempConfig;
beforeEach(() => {
  temp = makeTempConfig({ user: "empty" });
});
afterEach(() => temp.cleanup());

describe("layeredFingerprint", () => {
  it("tells every pair of layers apart, the boundary between them and a missing layer included", () => {
    const pairs: [string | null, string | null][] = [[null, null], ["", null], [null, ""], ["", ""], ["a", "b"], ["ab", ""], ["", "ab"], ["a", null], [null, "a"]];
    const prints = pairs.map(([overlay, shipped]) => layeredFingerprint(overlay, shipped));
    expect(new Set(prints).size).toBe(pairs.length);
    expect(layeredFingerprint("a", "b")).toBe(layeredFingerprint("a", "b"));
  });
});

describe("layeredConfigFingerprint", () => {
  it("changes when either layer changes, and when the user file comes or goes", () => {
    const user = path.join(temp.configDir, "ui.yaml");
    const shipped = path.join(temp.defaultsDir, "ui.yaml");
    const start = layeredConfigFingerprint("ui");
    fs.appendFileSync(shipped, "\n# shipped comment\n");
    const shippedChanged = layeredConfigFingerprint("ui");
    expect(shippedChanged).not.toBe(start);
    fs.writeFileSync(user, "config_version: 3\n");
    const withUser = layeredConfigFingerprint("ui");
    expect(withUser).not.toBe(shippedChanged);
    fs.rmSync(user);
    expect(layeredConfigFingerprint("ui")).toBe(shippedChanged);
  });

  it("a profile file counts by itself: its template only while there is no file", () => {
    fs.mkdirSync(temp.profileDir, { recursive: true });
    const file = path.join(temp.profileDir, "me.yaml");
    fs.writeFileSync(file, "name: x\n");
    const before = layeredConfigFingerprint("me");
    fs.appendFileSync(path.join(temp.defaultsDir, "profile.example", "me.yaml"), "\n# changed\n");
    expect(layeredConfigFingerprint("me")).toBe(before);
  });
});
