// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ConfigError,
  configLayer,
  editorBackupRoot,
  hashConfigText,
  loadConfig,
  maskConfigText,
  readConfigText,
  resetConfigToDefault,
  restoreMaskedText,
  validateConfigText,
  writeConfigText,
} from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";

let tmp: TempConfig;
beforeEach(() => {
  tmp = makeTempConfig();
});
afterEach(() => tmp.cleanup());

const userText = (file: string): string => fs.readFileSync(path.join(tmp.configDir, file), "utf8");
const base = (name: "notify" | "ai" | "pipeline" | "channels" | "ui") => ({ baseHash: hashConfigText(readConfigText(name)), baseLayer: configLayer(name) });
const limits = { maxBytes: 1_000_000, backupsKeep: 3 };

function failure(name: Parameters<typeof validateConfigText>[0], text: string) {
  const result = validateConfigText(name, text);
  if (result.ok) throw new Error("expected issues");
  return result.issues;
}

describe("validateConfigText", () => {
  it("accepts a shipped file and returns the parsed value", () => {
    const result = validateConfigText("notify", userText("notify.yaml"));
    expect(result.ok).toBe(true);
  });

  it("reports a syntax error with its line", () => {
    const issues = failure("notify", "telegram:\n  enabled: true\n bad: [\n");
    expect(issues[0]).toMatchObject({ source: "yaml" });
    expect(issues[0]?.line).toBeGreaterThanOrEqual(2);
  });

  it("points an unknown key at the key", () => {
    const text = `${userText("notify.yaml")}\nnot_a_key: 1\n`;
    const issues = failure("notify", text);
    const issue = issues.find((i) => i.path === "not_a_key");
    expect(issue).toMatchObject({ message: "unknown key", exact: true });
    expect(text.split("\n")[(issue?.line ?? 1) - 1]).toContain("not_a_key");
  });

  it("points a wrong type at the value", () => {
    const text = userText("notify.yaml").replace(/^max_per_cycle: .*$/m, "max_per_cycle: lots");
    const issue = failure("notify", text).find((i) => i.path === "max_per_cycle");
    expect(issue?.exact).toBe(true);
    expect(text.split("\n")[(issue?.line ?? 1) - 1]).toContain("max_per_cycle");
  });

  it("points a missing key at the nearest parent that exists", () => {
    const text = userText("notify.yaml").replace(/^(\s+)start: .*\n/m, "");
    const issues = failure("notify", text);
    const issue = issues.find((i) => i.path === "quiet_hours.start");
    expect(issue).toBeDefined();
    expect(issue?.exact).toBe(false);
    expect(text.split("\n")[(issue?.line ?? 1) - 1]).toContain("quiet_hours");
  });

  it("names a list index in the path", () => {
    const text = userText("notify.yaml").replace(/budget_thresholds: \[.*\]/, "budget_thresholds: [50, oops]");
    expect(failure("notify", text).some((i) => i.path === "alerts.budget_thresholds[1]")).toBe(true);
  });

  it("checks config_version against the code's version", () => {
    const bare = userText("ui.yaml").replace("config_version: 2\n", "");
    const issues = failure("ui", bare);
    expect(issues[0]).toMatchObject({ source: "version" });
    expect(issues[0]?.message).toContain("needs 2");
    expect(validateConfigText("ui", userText("ui.yaml")).ok).toBe(true);
    const newer = failure("ui", `config_version: 3\n${bare}`);
    expect(newer[0]?.message).toContain("newer");
    expect(failure("ui", `config_version: x\n${bare}`)[0]?.source).toBe("version");
  });

  it("checks ai.yaml's models against models.yaml", () => {
    const text = userText("ai.yaml").replace(/^(\s+)model: .*$/m, "$1model: no-such-model");
    const issues = failure("ai", text);
    expect(issues.some((i) => i.source === "catalog")).toBe(true);
  });

  it("checks models.yaml against the models ai.yaml uses (the other direction)", () => {
    const models = readConfigText("models");
    const ai = loadConfig("ai");
    const used = ai.providers.deepseek.model;
    // remove that model's entry id from the catalog text
    const broken = models.split(`id: ${used}`).join("id: renamed-model");
    const result = validateConfigText("models", broken);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((i) => i.file === "ai")).toBe(true);
  });
});

describe("writeConfigText", () => {
  it("writes the text byte for byte, backs up the old text and refreshes the cache", async () => {
    const before = userText("notify.yaml");
    const text = before.replace(/^max_per_cycle: \d+/m, "max_per_cycle: 7") + "\n# my note\n";
    const result = await writeConfigText("notify", text, { ...base("notify"), ...limits });
    expect(userText("notify.yaml")).toBe(text);
    expect(loadConfig("notify").max_per_cycle).toBe(7);
    expect(result.backup).not.toBeNull();
    expect(fs.readFileSync(result.backup ?? "", "utf8")).toBe(before);
    expect(result.backup?.startsWith(editorBackupRoot())).toBe(true);
  });

  it("refuses invalid text and leaves the file alone", async () => {
    const before = userText("notify.yaml");
    await expect(writeConfigText("notify", `${before}\nbogus: 1\n`, { ...base("notify"), ...limits })).rejects.toMatchObject({ kind: "schema" });
    await expect(writeConfigText("notify", "a: [", { ...base("notify"), ...limits })).rejects.toMatchObject({ kind: "yaml" });
    expect(userText("notify.yaml")).toBe(before);
  });

  it("refuses text above max_bytes", async () => {
    await expect(writeConfigText("notify", userText("notify.yaml"), { ...base("notify"), maxBytes: 100, backupsKeep: 3 })).rejects.toMatchObject({ kind: "too_large" });
  });

  it("refuses when the file changed since it was opened (stale)", async () => {
    const opened = base("notify");
    const changed = userText("notify.yaml").replace(/^max_per_cycle: \d+/m, "max_per_cycle: 9");
    fs.writeFileSync(path.join(tmp.configDir, "notify.yaml"), changed);
    const attempt = writeConfigText("notify", userText("notify.yaml") + "# mine\n", { ...opened, ...limits });
    await expect(attempt).rejects.toBeInstanceOf(ConfigError);
    await expect(attempt).rejects.toMatchObject({ kind: "stale" });
    expect(userText("notify.yaml")).toBe(changed);
    // after reloading the latest file it can be saved
    await writeConfigText("notify", `${changed}# mine\n`, { ...base("notify"), ...limits });
    expect(userText("notify.yaml")).toBe(`${changed}# mine\n`);
  });

  it("keeps only backups_keep backups per file", async () => {
    for (let i = 0; i < 5; i++) {
      const current = userText("notify.yaml");
      await writeConfigText("notify", `${current}# edit ${i}\n`, { ...base("notify"), maxBytes: 1_000_000, backupsKeep: 3, now: new Date(Date.UTC(2026, 9, 9, 12, 0, i)) });
    }
    const dirs = fs.readdirSync(editorBackupRoot()).filter((dir) => fs.existsSync(path.join(editorBackupRoot(), dir, "notify.yaml")));
    expect(dirs).toHaveLength(3);
    expect(dirs.sort()[0]).toContain("12-00-02");
  });

  it("a shipped default file: the first save creates the user override, restoring the default removes it", async () => {
    expect(configLayer("pipeline")).toBe("default");
    const text = `${readConfigText("pipeline")}\n# mine\n`;
    const written = await writeConfigText("pipeline", text, { ...base("pipeline"), ...limits });
    expect(written.backup).toBeNull();
    expect(configLayer("pipeline")).toBe("user");
    expect(fs.readFileSync(path.join(tmp.configDir, "pipeline.yaml"), "utf8")).toBe(text);
    const reset = await resetConfigToDefault("pipeline", { ...base("pipeline"), backupsKeep: 3 });
    expect(reset.backup).not.toBeNull();
    expect(configLayer("pipeline")).toBe("default");
    expect(fs.existsSync(path.join(tmp.configDir, "pipeline.yaml"))).toBe(false);
    expect(fs.readFileSync(reset.backup ?? "", "utf8")).toBe(text);
    // only the user directory changed
    expect(fs.readFileSync(path.join(tmp.defaultsDir, "pipeline.yaml"), "utf8")).not.toContain("# mine");
  });

  it("a user file: restoring the default writes the shipped text and backs up the old one", async () => {
    const mine = userText("notify.yaml").replace(/^max_per_cycle: \d+/m, "max_per_cycle: 11");
    fs.writeFileSync(path.join(tmp.configDir, "notify.yaml"), mine);
    const reset = await resetConfigToDefault("notify", { ...base("notify"), backupsKeep: 3 });
    expect(userText("notify.yaml")).toBe(fs.readFileSync(path.join(tmp.defaultsDir, "notify.yaml"), "utf8"));
    expect(fs.readFileSync(reset.backup ?? "", "utf8")).toBe(mine);
  });
});

describe("proxy credentials (C4)", () => {
  const withProxies = (): string => {
    const text = userText("sources.yaml");
    return text.replace("proxies: []", 'proxies:\n    - "http://alice:s3cret@proxy.example:8080"\n    - http://proxy2.example:3128');
  };

  it("masks the credentials of jobspy.proxies and nothing else", () => {
    const masked = maskConfigText("channels", withProxies());
    expect(masked).not.toContain("s3cret");
    expect(masked).not.toContain("alice");
    expect(masked).toContain("***:***@proxy.example:8080");
    expect(masked).toContain("http://proxy2.example:3128");
  });

  it("reads out and writes back unchanged", () => {
    const current = withProxies();
    const restored = restoreMaskedText("channels", maskConfigText("channels", current), current);
    expect(restored).toEqual({ ok: true, text: current });
  });

  it("keeps the proxies when other lines were edited", () => {
    const current = withProxies();
    const edited = maskConfigText("channels", current).replace(/timeout_ms: (\d+)/, "timeout_ms: 12345");
    const restored = restoreMaskedText("channels", edited, current);
    expect(restored.ok && restored.text.includes("alice:s3cret@")).toBe(true);
    expect(restored.ok && restored.text.includes("12345")).toBe(true);
  });

  it("refuses a changed, added or removed proxy", () => {
    const current = withProxies();
    const masked = maskConfigText("channels", current);
    expect(restoreMaskedText("channels", masked.replace("proxy.example:8080", "other.example:8080"), current)).toEqual({ ok: false, reason: "proxies_changed" });
    expect(restoreMaskedText("channels", masked.replace("***:***@", "bob:pw@"), current)).toEqual({ ok: false, reason: "proxies_changed" });
    expect(restoreMaskedText("channels", masked.replace(/\n\s+- http:\/\/proxy2.*/, ""), current)).toEqual({ ok: false, reason: "proxies_changed" });
  });

  describe("when the proxy entries cannot be located (fail closed)", () => {
    const broken = (): string => `${withProxies()}\n  : [unclosed`; // a syntax error elsewhere in the file
    const aliased = (): string =>
      userText("sources.yaml").replace("proxies: []", 'proxies:\n    - &p "http://alice:s3cret@proxy.example:8080"\n    - *p\n    - http://bob:hunter2@proxy2.example:3128');

    it("masks every credential URL instead of showing the file as it is", () => {
      for (const text of [broken(), aliased()]) {
        const masked = maskConfigText("channels", text);
        expect(masked).not.toMatch(/s3cret|hunter2|alice|bob/);
        expect(masked).toContain("***:***@proxy.example:8080");
      }
    });

    it("saves the masked text back with the originals at the same positions, and refuses a pasted credential", () => {
      for (const current of [broken(), aliased()]) {
        const masked = maskConfigText("channels", current);
        const restored = restoreMaskedText("channels", masked, current);
        expect(restored).toEqual({ ok: true, text: current });
        const edited = restoreMaskedText("channels", masked.replace(/timeout_ms: (\d+)/, "timeout_ms: 777"), current);
        expect(edited.ok && edited.text.includes("alice:s3cret@") && edited.text.includes("777")).toBe(true);
        expect(restoreMaskedText("channels", masked.replace("***:***@", "eve:pw@"), current)).toEqual({ ok: false, reason: "proxies_changed" });
        expect(restoreMaskedText("channels", masked.replace(/\*\*\*:\*\*\*@proxy\.example:8080/, "proxy.example:8080"), current)).toEqual({ ok: false, reason: "proxies_changed" });
      }
    });
  });

  it("does not touch other files", () => {
    expect(maskConfigText("notify", "a: http://u:p@x\n")).toBe("a: http://u:p@x\n");
  });
});
