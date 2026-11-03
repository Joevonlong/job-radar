import fs from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resetConfigCache } from "@/lib/config";
import { ARCHIVE_META_YAML } from "@/lib/ops/config-archive";
import { tarChunks } from "@/lib/ops/tar";
import { createSetupGate } from "@/lib/setup/runner-gate";
import { readSetupState, resetSetupStateCache } from "@/lib/setup";

import { createRestoreHarness, type RestoreHarness } from "../../ops/restore-harness";

/**
 * What the shell's backfill in `restore.sh --with-config` writes, read by the real code: the runner has to treat the
 * restored install as set up (and one whose archive says a missing setup.yaml means pending, as not set up). A throw-away
 * checkout with stubs for docker and the service managers (`tests/ops/restore-harness.ts`).
 */
const MARKER = "data/config/.archive-meta.yaml";
const WARNING = "predates the setup wizard";

let harness: RestoreHarness;
const savedConfigDir = process.env.JOB_RADAR_CONFIG_DIR;

beforeEach(() => {
  harness = createRestoreHarness();
  process.env.JOB_RADAR_CONFIG_DIR = path.dirname(harness.live("x"));
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.JOB_RADAR_CONFIG_DIR;
  else process.env.JOB_RADAR_CONFIG_DIR = savedConfigDir;
  resetSetupStateCache();
  resetConfigCache();
  harness.cleanup();
});

function restoreArchive(members: Record<string, string>): { stderr: string } {
  const files = Object.entries(members).map(([name, text]) => ({ name, data: Buffer.from(text) }));
  fs.writeFileSync(harness.dump.replace(/\.dump$/, ".config.tgz"), gzipSync(Buffer.concat([...tarChunks(files)])));
  const result = harness.restore();
  resetSetupStateCache();
  resetConfigCache();
  return result;
}

const gateAnswers = (): { lines: string[]; scheduled: boolean; catchup: boolean; suggest: boolean } => {
  const lines: string[] = [];
  const gate = createSetupGate((line) => lines.push(line));
  return { scheduled: gate("scheduled", "the cycle"), catchup: gate("catchup", "the catch-up"), suggest: gate("suggest", "the suggestions"), lines };
};

describe("the runner's gate after restore.sh --with-config", () => {
  it("an archive from before the wizard: the written setup.yaml is complete for the real reader, and the gate lets the work through", () => {
    const { stderr } = restoreArchive({ "data/config/ui.yaml": "config_version: 1\n", "data/config/schedule.yaml": "timezone: UTC\n", "data/profile/me.yaml": "city: x\n" });
    expect(stderr).toContain(WARNING);
    expect(readSetupState().pending).toBe(false);
    expect(gateAnswers()).toEqual({ scheduled: true, catchup: true, suggest: true, lines: [] });
  });

  it("an archive with the marker and no setup.yaml: it stays pending, no warning, and the gate holds the work back", () => {
    const { stderr } = restoreArchive({ [MARKER]: ARCHIVE_META_YAML, "data/config/ui.yaml": "config_version: 1\n", "data/profile/me.yaml": "city: x\n" });
    expect(stderr).not.toContain(WARNING);
    expect(fs.existsSync(harness.live("setup.yaml"))).toBe(false);
    expect(fs.existsSync(harness.live(".archive-meta.yaml"))).toBe(false);
    expect(readSetupState().pending).toBe(true);
    const answers = gateAnswers();
    expect(answers).toMatchObject({ scheduled: false, catchup: false, suggest: false });
    expect(answers.lines).toHaveLength(3);
  });
});
