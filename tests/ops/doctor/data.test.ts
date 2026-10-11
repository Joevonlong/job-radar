// @vitest-environment node
import { describe, expect, it } from "vitest";

import { backupCheck, diskCheck, dockerLocationCheck, internalDiskCheck, parsePmset, powerCheck } from "@/lib/ops/doctor/checks/data";

import { ago, DOCKER_DATA, makeContext, only, ran, results, PMSET_OK } from "./helpers";

const file = (hoursAgo: number, name = "jobradar-20261007-033000.dump", hasConfig = true) => ({ name, path: `/b/${name}`, bytes: 3 * 1024 * 1024, modifiedAt: ago(hoursAgo * 3600), hasConfig });
const GB = 1024 ** 3;

describe("backup.recent", () => {
  it("ok with the newest backup in the window", async () => {
    const r = await only(backupCheck, makeContext());
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("jobradar-20261007-033000.dump");
    expect(r.detail).toContain("5.0 MB");
    expect(r.detail).toContain("10 小时前");
  });
  it("is judged by backup.max_age_hours: fine at 30 h, fails at 31 h", async () => {
    expect((await only(backupCheck, makeContext({ probes: { backups: async () => [file(30)] } }))).status).toBe("ok");
    const r = await only(backupCheck, makeContext({ probes: { backups: async () => [file(31)] } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("超过 30 小时");
    expect(r.hint).toContain("scripts/ops/backup.sh");
  });
  it("takes max_age_hours from schedule.yaml", async () => {
    const ctx = makeContext({ schedule: (raw) => ((raw.backup as Record<string, unknown>).max_age_hours = 12), probes: { backups: async () => [file(13)] } });
    expect((await only(backupCheck, ctx)).status).toBe("fail");
  });
  it("only looks at the newest file", async () => {
    const files = [file(2, "jobradar-20261007-100000.dump"), file(200, "jobradar-20260929-033000.dump")];
    expect((await only(backupCheck, makeContext({ probes: { backups: async () => files } }))).detail).toContain("共 2 份");
  });
  it("fails when the directory does not exist", async () => {
    const r = await only(backupCheck, makeContext({ probes: { backups: async () => null } }));
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("/b 不存在");
    expect(r.hint).toContain("mkdir -p data/backups");
  });
  it("warns (not fails) right after the first deploy, when there is no backup yet", async () => {
    const r = await only(backupCheck, makeContext({ probes: { backups: async () => [] } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("还没有自动备份");
  });
  it("warns when the newest dump has no config archive, unless backup.config_archive is off", async () => {
    const probes = { backups: async () => [file(2, "jobradar-20261007-100000.dump", false)] };
    const r = await only(backupCheck, makeContext({ probes }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("jobradar-20261007-100000.dump");
    expect(r.hint).toContain("backup.config_archive");
    const off = makeContext({ probes, schedule: (raw) => ((raw.backup as Record<string, unknown>).config_archive = false) });
    expect((await only(backupCheck, off)).status).toBe("ok");
  });
  it("warns when backups are switched off", async () => {
    const r = await only(backupCheck, makeContext({ schedule: (raw) => ((raw.backup as Record<string, unknown>).enabled = false) }));
    expect(r.status).toBe("warn");
  });
});

describe("disk.free", () => {
  const disk = (backupsGb: number, homeGb = 100) => async (path: string) => ({ freeBytes: (path === "/b" ? backupsGb : homeGb) * GB, totalBytes: 500 * GB });
  it("ok with plenty of space on both volumes", async () => {
    const list = await results(diskCheck, makeContext());
    expect(list.map((r) => [r.id, r.status])).toEqual([["disk.backups", "ok"], ["disk.docker", "ok"]]);
    expect(list[0]?.detail).toBe("剩余 100.0 GB（20%）");
  });
  it("warns below doctor.warn_free_disk_gb and fails below doctor.min_free_disk_gb", async () => {
    const warn = await results(diskCheck, makeContext({ probes: { disk: disk(19.9) } }));
    expect(warn[0]?.status).toBe("warn");
    const fail = await results(diskCheck, makeContext({ probes: { disk: disk(4.9) } }));
    expect(fail[0]?.status).toBe("fail");
    expect(fail[0]?.detail).toContain("备份会写不进去");
    expect((await results(diskCheck, makeContext({ probes: { disk: disk(20) } })))[0]?.status).toBe("ok");
    expect((await results(diskCheck, makeContext({ probes: { disk: disk(5) } })))[0]?.status).toBe("warn");
  });
  it("the Docker volume has its own verdict", async () => {
    const list = await results(diskCheck, makeContext({ probes: { disk: disk(100, 2) } }));
    expect(list[1]).toMatchObject({ id: "disk.docker", status: "fail" });
    expect(list[1]?.detail).toContain("数据库会停");
  });
  it("warns when the space cannot be read", async () => {
    expect((await results(diskCheck, makeContext({ probes: { disk: async () => null } })))[0]?.status).toBe("warn");
  });
  it("disk.docker measures Docker Desktop's DataFolder and names it", async () => {
    const ctx = makeContext();
    const list = await results(diskCheck, ctx);
    expect(ctx.probes.disk).toHaveBeenCalledWith(DOCKER_DATA);
    expect(list[1]?.detail).toBe(`剩余 100.0 GB（20%），量的是 ${DOCKER_DATA}`);
  });
  it("the clean-up hint names the build cache and the worker logs on the project volume", async () => {
    const list = await results(diskCheck, makeContext({ probes: { disk: disk(4) } }));
    expect(list[0]?.hint).toContain("docker builder prune");
    expect(list[0]?.hint).toContain("/Volumes/SSD/work/job-radar/data/logs");
    expect(list[0]?.hint).not.toContain("Library/Logs");
  });
  it("reports one volume once when Docker's data folder is the backup directory", async () => {
    const ctx = makeContext({ probes: { dockerData: async () => ({ path: "/b", source: "settings-store" as const }) } });
    expect(await results(diskCheck, ctx)).toHaveLength(1);
  });
});

describe("disk.docker_location", () => {
  it("ok when Docker's data is on the volume the project lives on", async () => {
    const ctx = makeContext();
    const r = await only(dockerLocationCheck, ctx);
    expect(r).toMatchObject({ id: "disk.docker_location", status: "ok" });
    expect(r.detail).toContain("/Volumes/SSD");
    expect(ctx.probes.sameVolume).toHaveBeenCalledWith(DOCKER_DATA, "/Volumes/SSD/work/job-radar");
  });
  it("hints which docker_data_path to pin in ai.yaml while it is unset, and stays quiet once it matches", async () => {
    const unset = await only(dockerLocationCheck, makeContext({ ai: (raw) => { delete (raw.host_worker as Record<string, unknown>).docker_data_path; } }));
    expect(unset.status).toBe("ok");
    expect(unset.hint).toContain(`set host_worker.docker_data_path: ${DOCKER_DATA}`);
    const pinned = await only(dockerLocationCheck, makeContext({ ai: (raw) => ((raw.host_worker as Record<string, unknown>).docker_data_path = DOCKER_DATA) }));
    expect(pinned.hint).toBeUndefined();
    const other = await only(dockerLocationCheck, makeContext({ ai: (raw) => ((raw.host_worker as Record<string, unknown>).docker_data_path = "/Volumes/Other/.docker-data") }));
    expect(other.hint).toContain("不一致");
  });
  it("warns when it is elsewhere (the internal disk), pointing at the storage guide", async () => {
    const internal = "/Users/test/Library/Containers/com.docker.docker/Data/vms/0/data";
    const r = await only(dockerLocationCheck, makeContext({ probes: { dockerData: async () => ({ path: internal, source: "settings-store" as const }), sameVolume: async () => false } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain(internal);
    expect(r.detail).toContain("不在项目所在的卷 /Volumes/SSD 上");
    expect(r.hint).toContain("docs/host-setup.md");
  });
  it("takes the guide from doctor.storage_guide", async () => {
    const r = await only(dockerLocationCheck, makeContext({ settings: { storage_guide: "/guide.md" }, probes: { sameVolume: async () => false } }));
    expect(r.hint).toContain("/guide.md");
  });
  it("says when Docker's settings could not be read", async () => {
    const r = await only(dockerLocationCheck, makeContext({ probes: { dockerData: async () => ({ path: "/Users/test/x", source: "default" as const }), sameVolume: async () => false } }));
    expect(r.detail).toContain("没读到 Docker Desktop 设置里的 DataFolder");
  });
  it("warns when a volume cannot be read, and is skipped off macOS", async () => {
    expect((await only(dockerLocationCheck, makeContext({ probes: { sameVolume: async () => null } }))).status).toBe("warn");
    const linux = makeContext({ platform: "linux" });
    expect((await only(dockerLocationCheck, linux)).status).toBe("ok");
    expect(linux.probes.sameVolume).not.toHaveBeenCalled();
  });
});

describe("disk.internal", () => {
  const internal = (gb: number) => async (target: string) => ({ freeBytes: (target === "/System/Volumes/Data" ? gb : 500) * GB, totalBytes: 460 * GB });
  it("measures the macOS system data volume against its own thresholds", async () => {
    const ctx = makeContext({ probes: { disk: internal(40) } });
    expect(await only(internalDiskCheck, ctx)).toMatchObject({ id: "disk.internal", status: "ok", detail: "剩余 40.0 GB（9%），量的是 /System/Volumes/Data" });
    expect((await only(internalDiskCheck, makeContext({ probes: { disk: internal(16) } }))).status).toBe("warn");
    const full = await only(internalDiskCheck, makeContext({ probes: { disk: internal(9) } }));
    expect(full.status).toBe("fail");
    expect(full.detail).toContain("低于 10 GB");
    expect(full.hint).toContain("disk.docker_location");
  });
  it("follows doctor.internal_warn_free_disk_gb / internal_min_free_disk_gb", async () => {
    const ctx = makeContext({ settings: { internal_warn_free_disk_gb: 12, internal_min_free_disk_gb: 4 }, probes: { disk: internal(16) } });
    expect((await only(internalDiskCheck, ctx)).status).toBe("ok");
  });
  it("measures / off macOS", async () => {
    const ctx = makeContext({ platform: "linux" });
    await only(internalDiskCheck, ctx);
    expect(ctx.probes.disk).toHaveBeenCalledWith("/");
  });
});

describe("host.power", () => {
  it("parses pmset -g", () => {
    expect(parsePmset(PMSET_OK)).toEqual({ autorestart: 1, sleep: 0 });
    expect(parsePmset(" sleep 1\n womp 1")).toEqual({ autorestart: null, sleep: 1 });
  });
  it("ok with autorestart 1 and sleep 0", async () => {
    expect((await only(powerCheck, makeContext())).status).toBe("ok");
  });
  it("warns with both problems named", async () => {
    const r = await only(powerCheck, makeContext({ commands: { "pmset -g": ran(" sleep 1\n womp 1") } }));
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("autorestart 是 未设置");
    expect(r.detail).toContain("sleep 是 1");
    expect(r.hint).toContain("sudo pmset");
  });
  it("is skipped off macOS", async () => {
    const ctx = makeContext({ platform: "linux" });
    expect((await only(powerCheck, ctx)).status).toBe("ok");
    expect(ctx.probes.run).not.toHaveBeenCalled();
  });
});
