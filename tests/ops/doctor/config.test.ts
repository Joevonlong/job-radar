// @vitest-environment node
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../../config/helpers";

const schema = configRegistry.schedule.schema;
const shipped = () => structuredClone(shippedYaml("schedule.yaml"));

describe("schedule.yaml: doctor block and backup.max_age_hours", () => {
  it("the shipped file carries both and they parse", () => {
    const parsed = schema.parse(shipped());
    expect(parsed.backup.max_age_hours).toBe(30);
    expect(parsed.doctor).toMatchObject({ compose_project: "job-radar", web_url: "http://127.0.0.1:3000", compose_services: ["db", "web", "runner", "jobspy"] });
  });

  it("a file without them (an older config, the UAT copy) gets the same values as defaults", () => {
    const raw = shipped();
    delete raw.doctor;
    delete (raw.backup as Record<string, unknown>).max_age_hours;
    const parsed = schema.parse(raw);
    expect(parsed.doctor).toEqual(schema.parse(shipped()).doctor);
    expect(parsed.backup.max_age_hours).toBe(30);
  });

  it.each([
    ["max_age_hours 0", (raw: Record<string, unknown>) => ((raw.backup as Record<string, unknown>).max_age_hours = 0)],
    ["unknown doctor key", (raw: Record<string, unknown>) => ((raw.doctor as Record<string, unknown>).typo = 1)],
    ["web_url not a URL", (raw: Record<string, unknown>) => ((raw.doctor as Record<string, unknown>).web_url = "not a url")],
    ["no compose service", (raw: Record<string, unknown>) => ((raw.doctor as Record<string, unknown>).compose_services = [])],
    ["warn below min disk", (raw: Record<string, unknown>) => Object.assign(raw.doctor as Record<string, unknown>, { min_free_disk_gb: 10, warn_free_disk_gb: 5 })],
    ["zero time-out", (raw: Record<string, unknown>) => ((raw.doctor as Record<string, unknown>).command_timeout_seconds = 0)],
  ])("rejects %s", (_name, edit) => {
    const raw = shipped();
    edit(raw);
    expect(schema.safeParse(raw).success).toBe(false);
  });
});

describe("schedule.yaml: deploy block and the internal-disk / storage doctor keys", () => {
  it("ships them and they parse", () => {
    const parsed = schema.parse(shipped());
    expect(parsed.deploy).toEqual({ prune_build_cache: true, build_cache_keep_gb: 5, prune_dangling_images: true, drain_timeout_seconds: 900, drain_poll_seconds: 10 });
    expect(parsed.doctor).toMatchObject({ internal_min_free_disk_gb: 10, internal_warn_free_disk_gb: 30, storage_guide: "docs/host-setup.md" });
  });

  it("a file without them gets the shipped values as defaults", () => {
    const raw = shipped();
    delete raw.deploy;
    for (const key of ["internal_min_free_disk_gb", "internal_warn_free_disk_gb", "storage_guide"]) delete (raw.doctor as Record<string, unknown>)[key];
    const parsed = schema.parse(raw);
    expect(parsed.deploy).toEqual(schema.parse(shipped()).deploy);
    expect(parsed.doctor).toEqual(schema.parse(shipped()).doctor);
  });

  it("a deploy block without the drain keys waits 900 s, looking every 10 s; 0 = do not wait", () => {
    const raw = shipped();
    raw.deploy = { prune_build_cache: true, build_cache_keep_gb: 5, prune_dangling_images: true };
    expect(schema.parse(raw).deploy).toMatchObject({ drain_timeout_seconds: 900, drain_poll_seconds: 10 });
    raw.deploy = { ...(raw.deploy as Record<string, unknown>), drain_timeout_seconds: 0 };
    expect(schema.parse(raw).deploy.drain_timeout_seconds).toBe(0);
  });

  it("accepts keeping no build cache", () => {
    const raw = shipped();
    (raw.deploy as Record<string, unknown>).build_cache_keep_gb = 0;
    expect(schema.parse(raw).deploy.build_cache_keep_gb).toBe(0);
  });

  it.each([
    ["negative cache size", (raw: Record<string, unknown>) => ((raw.deploy as Record<string, unknown>).build_cache_keep_gb = -1)],
    ["fractional cache size", (raw: Record<string, unknown>) => ((raw.deploy as Record<string, unknown>).build_cache_keep_gb = 2.5)],
    ["unknown deploy key", (raw: Record<string, unknown>) => ((raw.deploy as Record<string, unknown>).prune_volumes = true)],
    ["negative drain timeout", (raw: Record<string, unknown>) => ((raw.deploy as Record<string, unknown>).drain_timeout_seconds = -1)],
    ["zero drain poll", (raw: Record<string, unknown>) => ((raw.deploy as Record<string, unknown>).drain_poll_seconds = 0)],
    ["prune flag not a boolean", (raw: Record<string, unknown>) => ((raw.deploy as Record<string, unknown>).prune_dangling_images = "yes")],
    ["internal warn below internal min", (raw: Record<string, unknown>) => Object.assign(raw.doctor as Record<string, unknown>, { internal_min_free_disk_gb: 20, internal_warn_free_disk_gb: 10 })],
    ["empty storage guide", (raw: Record<string, unknown>) => ((raw.doctor as Record<string, unknown>).storage_guide = " ")],
  ])("rejects %s", (_name, edit) => {
    const raw = shipped();
    edit(raw);
    expect(schema.safeParse(raw).success).toBe(false);
  });
});
