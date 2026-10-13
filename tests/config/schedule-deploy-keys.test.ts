// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { configRegistry } from "@/lib/config";

import { FIXTURE_DEFAULTS_DIR, shippedYaml } from "./helpers";

/** schedule.yaml deploy.ai_worker_*: the release-directory keys of the host ai-worker, schema defaults only. */
const schema = configRegistry.schedule.schema;
const base = (): Record<string, unknown> =>
  YAML.parse(fs.readFileSync(path.join(FIXTURE_DEFAULTS_DIR, "schedule.yaml"), "utf8")) as Record<string, unknown>;
const withDeploy = (deploy: Record<string, unknown>): Record<string, unknown> => {
  const raw = base();
  raw.deploy = { ...((raw.deploy as Record<string, unknown> | undefined) ?? {}), ...deploy };
  return raw;
};
const KEYS = ["ai_worker_releases_keep", "ai_worker_stop_timeout_seconds", "ai_worker_swap_timeout_seconds"] as const;

describe("schedule.yaml deploy.ai_worker_* keys", () => {
  it("default to keep 3, stop 60 s, swap 120 s when the deploy block leaves them out", () => {
    const raw = base();
    const deploy = (raw.deploy as Record<string, unknown> | undefined) ?? {};
    for (const key of KEYS) delete deploy[key];
    raw.deploy = deploy;
    expect(schema.parse(raw).deploy).toMatchObject({ ai_worker_releases_keep: 3, ai_worker_stop_timeout_seconds: 60, ai_worker_swap_timeout_seconds: 120 });
  });

  it("default the same way when there is no deploy block at all", () => {
    const raw = base();
    delete raw.deploy;
    expect(schema.parse(raw).deploy).toMatchObject({ ai_worker_releases_keep: 3, ai_worker_stop_timeout_seconds: 60, ai_worker_swap_timeout_seconds: 120 });
  });

  it("keep at least 2 releases", () => {
    expect(schema.safeParse(withDeploy({ ai_worker_releases_keep: 2 })).success).toBe(true);
    expect(schema.safeParse(withDeploy({ ai_worker_releases_keep: 1 })).success).toBe(false);
    expect(schema.safeParse(withDeploy({ ai_worker_releases_keep: 2.5 })).success).toBe(false);
  });

  it("wait at least 10 s after SIGTERM", () => {
    expect(schema.safeParse(withDeploy({ ai_worker_stop_timeout_seconds: 10, ai_worker_swap_timeout_seconds: 20 })).success).toBe(true);
    expect(schema.safeParse(withDeploy({ ai_worker_stop_timeout_seconds: 9, ai_worker_swap_timeout_seconds: 20 })).success).toBe(false);
  });

  it("refuse a swap timeout below the stop timeout + 10, on that key", () => {
    expect(schema.safeParse(withDeploy({ ai_worker_stop_timeout_seconds: 60, ai_worker_swap_timeout_seconds: 70 })).success).toBe(true);
    const result = schema.safeParse(withDeploy({ ai_worker_stop_timeout_seconds: 60, ai_worker_swap_timeout_seconds: 69 }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.path.join("."))).toContain("deploy.ai_worker_swap_timeout_seconds");
    // the defaults satisfy it; a raised stop timeout alone breaks it
    expect(schema.safeParse(withDeploy({ ai_worker_stop_timeout_seconds: 115 })).success).toBe(false);
  });

  it("are not written into the shipped schedule.yaml (schema defaults only)", () => {
    const deploy = (shippedYaml("schedule.yaml").deploy as Record<string, unknown> | undefined) ?? {};
    for (const key of KEYS) expect(Object.keys(deploy)).not.toContain(key);
  });
});
