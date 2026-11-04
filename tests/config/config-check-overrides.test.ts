// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { currentConfigVersion } from "@/lib/config";

import { makeTempConfig, type TempConfig } from "./helpers";
import { runConfigScript } from "./run-script";

/** `pnpm config:check` over overlay files: the per-file counts, the notes and `--overrides`. Snapshots, with the temp paths replaced. */
describe("pnpm config:check overlay report", () => {
  let tmp: TempConfig;
  beforeEach(() => {
    tmp = makeTempConfig({ user: "empty" });
    const write = (file: string, name: "schedule" | "ui" | "ai", body: string) => fs.writeFileSync(path.join(tmp.configDir, file), `config_version: ${currentConfigVersion(name)}\n${body}`);
    write("schedule.yaml", "schedule", "backup:\n  keep_daily: 99\n  max_age_hours: !unset\n  keep_typo: !unset\n");
    write("ui.yaml", "ui", "trend_cycles: 7\nconfig_editor:\n  backups_keep: 20\n");
    write(
      "ai.yaml",
      "ai",
      "providers:\n  claude_cli:\n    command: /opt/private-bin/claude\n  deepseek:\n    base_url: https://user:pass@api.example.com/v1\n    daily_request_cap: 61\ntranslation:\n  glossary:\n    widget: Bauteil\n",
    );
  });
  afterEach(() => tmp.cleanup());

  const normalise = (out: string): string => out.split(fs.realpathSync(tmp.configDir)).join("<user>").split(tmp.configDir).join("<user>");

  it("--overrides lists every key; a protected key shows no value and no URL credentials appear", () => {
    const run = runConfigScript(tmp, "config-check.ts", ["--overrides"]);
    expect(run.status, run.out).toBe(0);
    expect(run.out).not.toContain("private-bin");
    expect(run.out).not.toContain("user:pass");
    expect(normalise(run.out)).toMatchInlineSnapshot(`
      "<user>/schedule.yaml  1 override, 2 unsets
        backup.keep_daily: 99
        backup.max_age_hours: !unset
        backup.keep_typo: !unset  (the shipped file has no such key)
      <user>/ai.yaml  4 overrides, 0 unsets
        providers.claude_cli.command: (protected key, value not shown)
        providers.deepseek.base_url: (protected key, value not shown)
        providers.deepseek.daily_request_cap: 61
        translation.glossary.widget: "Bauteil"
      <user>/ui.yaml  2 overrides, 0 unsets
        trend_cycles: 7  (equals the shipped value)
        config_editor.backups_keep: 20  (equals the shipped value)
      "
    `);
  });

  it("--overrides --json gives the same entries with counts", () => {
    const run = runConfigScript(tmp, "config-check.ts", ["--overrides", "--json"]);
    const report = JSON.parse(run.out) as { files: { file: string; overrides: number; unsets: number; pins: number; invalidUnsets: number }[] };
    expect(report.files.map((f) => [path.basename(f.file), f.overrides, f.unsets, f.pins, f.invalidUnsets])).toEqual([
      ["schedule.yaml", 1, 2, 0, 1],
      ["ai.yaml", 4, 0, 0, 0],
      ["ui.yaml", 2, 0, 2, 0],
    ]);
  });

  it("the plain check prints the counts and notes the pins and the invalid unset, and still passes", () => {
    const run = runConfigScript(tmp, "config-check.ts");
    expect(run.status, run.out).toBe(0);
    const lines = normalise(run.out).split("\n").filter((line) => line.startsWith("·") || line.startsWith("! <user>"));
    expect(lines).toMatchInlineSnapshot(`
      [
        "· <user>/schedule.yaml  1 override, 2 unsets",
        "! <user>/schedule.yaml unsets 1 key(s) the shipped file does not have (backup.keep_typo): the line does nothing; remove it",
        "· <user>/ai.yaml  4 overrides, 0 unsets",
        "· <user>/ui.yaml  2 overrides, 0 unsets",
        "! <user>/ui.yaml pins 2 key(s) at the shipped value (trend_cycles, config_editor.backups_keep): they stop following product updates; remove one to follow the product, or keep it on purpose",
      ]
    `);
  });

  it("changes no file", () => {
    const snapshot = (): Record<string, string> => Object.fromEntries(fs.readdirSync(tmp.configDir).filter((f) => f.endsWith(".yaml")).map((f) => [f, fs.readFileSync(path.join(tmp.configDir, f), "utf8")]));
    const before = snapshot();
    runConfigScript(tmp, "config-check.ts", ["--overrides"]);
    runConfigScript(tmp, "config-check.ts");
    expect(snapshot()).toEqual(before);
    expect(fs.readdirSync(tmp.configDir).sort()).toEqual(["ai.yaml", "schedule.yaml", "ui.yaml"]);
  });
});
