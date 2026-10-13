// @vitest-environment node
import { describe, expect, it } from "vitest";

import { shippedConfigCheck } from "@/lib/ops/doctor/checks/shipped";
import type { CommandOutcome } from "@/lib/ops/doctor";

import { ago, CONTAINERS_STARTED, inspectJson, makeContext, only, ran, RUNNER_CONTAINER, shippedReports, WEB_CONTAINER, type Overrides } from "./helpers";

const PS = "docker ps --no-trunc --filter label=com.docker.compose.project=job-radar --format {{.ID}}";
const INSPECT = `docker inspect ${WEB_CONTAINER} ${RUNNER_CONTAINER}`;
const LAUNCHCTL = "launchctl print gui/501/io.jobradar.ai-worker";
const SYSTEMCTL = "systemctl --user show job-radar-ai-worker.service -p MainPID";

const host = (raw: Record<string, unknown>): void => {
  raw.execution = "host";
  (raw.host_worker as Record<string, unknown>).offline_after_seconds = 180;
};
const containers = (raw: Record<string, unknown>): void => {
  raw.execution = "container";
};

function context(overrides: Overrides = {}) {
  return makeContext({ locale: "en", ai: host, settings: { shipped_report_skew_seconds: 2 }, ...overrides, commands: { ...overrides.commands } });
}

const withReports = (edit: Parameters<typeof shippedReports>[0], overrides: Overrides = {}) =>
  context({ ...overrides, probes: { shippedConfigReports: async () => shippedReports(edit) } });

const updatedAt = (process: "web" | "runner" | "ai-worker", at: Date) => {
  const row = shippedReports()[process];
  if (row === null) throw new Error("no default report");
  return { [process]: { ...row, updatedAt: at } };
};

describe("config.shipped", () => {
  it("is ok when every report comes from the running process, and names each identity", async () => {
    const result = await only(shippedConfigCheck, context());
    expect(result).toMatchObject({ id: "config.shipped", group: "data", status: "ok" });
    expect(result.detail).toBe("web c3c3c3c3c3c3; runner c3c3c3c3c3c3; ai-worker c3c3c3c3c3c3");
  });

  it("is skipped without the database, and when the reports cannot be read", async () => {
    const down = context({ probes: { dbPing: async () => false } });
    expect(await only(shippedConfigCheck, down).catch((e: unknown) => e)).toMatchObject({ name: "SkipCheck" });
    const unreadable = context({
      probes: {
        shippedConfigReports: async () => {
          throw new Error("relation does not exist");
        },
      },
    });
    expect(await only(shippedConfigCheck, unreadable).catch((e: unknown) => e)).toMatchObject({ name: "SkipCheck" });
  });

  it("warns for a process without a report (bad data reads as no report), and still lists the confirmed ones", async () => {
    const result = await only(shippedConfigCheck, withReports({ runner: null }));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe("runner has not reported its shipped config; web c3c3c3c3c3c3; ai-worker c3c3c3c3c3c3");
    expect(result.hint).toContain("Shipped config identity");
  });

  it("lists every inconsistency, not only the first", async () => {
    const result = await only(shippedConfigCheck, withReports({ web: null, runner: null, "ai-worker": null }));
    expect(result.status).toBe("warn");
    expect(result.detail).toBe(["web", "runner", "ai-worker"].map((p) => `${p} has not reported its shipped config`).join("; "));
  });

  describe("containers", () => {
    it("warns when the report comes from another container than the running one", async () => {
      const row = shippedReports().web;
      if (row === null) throw new Error("no default report");
      const result = await only(shippedConfigCheck, withReports({ web: { ...row, report: { ...row.report, instance: "0123456789ab" } } }));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain(`web: the report comes from container 0123456789ab, not from the running one (${WEB_CONTAINER.slice(0, 12)})`);
    });

    it("accepts a report up to doctor.shipped_report_skew_seconds before the container start, not a millisecond earlier", async () => {
      const edge = new Date(CONTAINERS_STARTED.getTime() - 2000);
      expect((await only(shippedConfigCheck, withReports(updatedAt("web", edge)))).status).toBe("ok");
      const early = new Date(edge.getTime() - 1);
      const result = await only(shippedConfigCheck, withReports(updatedAt("web", early)));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain(`web: the report (${early.toISOString()}) is older than the start of the running container (${CONTAINERS_STARTED.toISOString()})`);
    });

    it("with a skew of 0, a report written exactly at the start is still accepted", async () => {
      const ctx = withReports(updatedAt("runner", CONTAINERS_STARTED), { settings: { shipped_report_skew_seconds: 0 } });
      expect((await only(shippedConfigCheck, ctx)).status).toBe("ok");
      const before = withReports(updatedAt("runner", new Date(CONTAINERS_STARTED.getTime() - 1)), { settings: { shipped_report_skew_seconds: 0 } });
      expect((await only(shippedConfigCheck, before)).status).toBe("warn");
    });

    it("warns when no container of the service runs", async () => {
      const commands = { [PS]: ran(`${WEB_CONTAINER}\n`), [`docker inspect ${WEB_CONTAINER}`]: ran(inspectJson([{ id: WEB_CONTAINER, service: "web" }])) };
      const result = await only(shippedConfigCheck, context({ commands }));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("runner: no running container in the compose project job-radar");
    });

    it("skips stopped containers and reads the rest when docker inspect exits 1 for one that went away", async () => {
      const json = inspectJson([
        { id: WEB_CONTAINER, service: "web" },
        { id: RUNNER_CONTAINER, service: "runner", running: false },
      ]);
      const result = await only(shippedConfigCheck, context({ commands: { [INSPECT]: ran(json, 1, "Error: No such object") } }));
      expect(result.detail).toContain("runner: no running container");
      expect(result.detail).toContain("web c3c3c3c3c3c3");
    });

    it("warns when Docker gives no start time", async () => {
      const json = inspectJson([
        { id: WEB_CONTAINER, service: "web", startedAt: "not a time" },
        { id: RUNNER_CONTAINER, service: "runner" },
      ]);
      const result = await only(shippedConfigCheck, context({ commands: { [INSPECT]: ran(json) } }));
      expect(result.detail).toContain("web: Docker gives no start time for the container");
    });

    it.each<[string, CommandOutcome, string]>([
      ["docker is missing", { kind: "missing" }, "docker"],
      ["docker ps times out", { kind: "timeout" }, "docker"],
      ["the daemon is down", ran("", 1, "Cannot connect"), "Docker"],
    ])("warns for both containers when %s", async (_name, outcome) => {
      const result = await only(shippedConfigCheck, context({ commands: { [PS]: outcome } }));
      expect(result.status).toBe("warn");
      expect(result.detail).toMatch(/^web: the containers cannot be read \(.+\); runner: the containers cannot be read \(.+\); ai-worker c3c3c3c3c3c3$/);
    });

    it.each<[string, CommandOutcome]>([
      ["not JSON", ran("garbage")],
      ["the wrong shape", ran(JSON.stringify({ Id: 1 }))],
      ["a time-out", { kind: "timeout" }],
    ])("warns when docker inspect gives %s", async (_name, outcome) => {
      const result = await only(shippedConfigCheck, context({ commands: { [INSPECT]: outcome } }));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("web: the containers cannot be read");
    });

    it("asks Docker only once for both containers", async () => {
      const ctx = context();
      await only(shippedConfigCheck, ctx);
      const calls = ctx.probes.run.mock.calls.map((c) => [c[0], ...c[1]].join(" "));
      expect(calls.filter((c) => c === PS)).toHaveLength(1);
      expect(calls.filter((c) => c.startsWith("docker inspect"))).toHaveLength(1);
    });

    it("checks only the processes in doctor.compose_services", async () => {
      const ctx = context({ settings: { compose_services: ["db", "jobspy"] } });
      const result = await only(shippedConfigCheck, ctx);
      expect(result.detail).toBe("ai-worker c3c3c3c3c3c3");
      expect(ctx.probes.run.mock.calls.some((c) => c[0] === "docker")).toBe(false);
    });
  });

  describe("ai-worker", () => {
    it("is not checked when the AI runs in the containers", async () => {
      const result = await only(shippedConfigCheck, withReports({ "ai-worker": null }, { ai: containers }));
      expect(result).toMatchObject({ status: "ok", detail: "web c3c3c3c3c3c3; runner c3c3c3c3c3c3" });
    });

    it("has nothing to check without web, runner or a host worker", async () => {
      const result = await only(shippedConfigCheck, context({ ai: containers, settings: { compose_services: ["db"] } }));
      expect(result).toMatchObject({ status: "ok", detail: expect.stringContaining("No process to check") });
    });

    it("warns when the newest report is older than host_worker.offline_after_seconds, and accepts one exactly at the limit", async () => {
      expect((await only(shippedConfigCheck, withReports(updatedAt("ai-worker", ago(180))))).status).toBe("ok");
      const result = await only(shippedConfigCheck, withReports(updatedAt("ai-worker", ago(181))));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("ai-worker: the newest report is");
    });

    it("warns when the PID differs from launchd's", async () => {
      const commands = { [LAUNCHCTL]: ran(["io.jobradar.ai-worker = {", "\tstate = running", "\tpid = 777", "}"].join("\n")) };
      const result = await only(shippedConfigCheck, context({ commands }));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("ai-worker: the report comes from PID 4242, the service runs PID 777");
    });

    it.each<[string, Overrides, string]>([
      ["launchd has no running process", { commands: { [LAUNCHCTL]: ran(["io.jobradar.ai-worker = {", "\tstate = waiting", "}"].join("\n")) } }, "io.jobradar.ai-worker has no running process"],
      ["the agent is not loaded", { commands: { [LAUNCHCTL]: ran("", 113, "Could not find service") } }, "io.jobradar.ai-worker is not loaded"],
      ["launchctl does not answer", { commands: { [LAUNCHCTL]: { kind: "timeout" } } }, "launchctl print did not answer"],
      ["there is no service manager", { platform: "win32" }, "no launchd or systemd on this system"],
      ["macOS gives no user id", { uid: null }, "no launchd or systemd on this system"],
      ["systemd has no main PID", { platform: "linux", commands: { [SYSTEMCTL]: ran("MainPID=0\n") } }, "job-radar-ai-worker.service has no running process"],
      ["systemctl fails", { platform: "linux", commands: { [SYSTEMCTL]: ran("", 1, "Failed to connect to bus") } }, "systemctl --user show did not answer"],
    ])("treats no PID as unknown (a warning) when %s", async (_name, overrides, reason) => {
      const result = await only(shippedConfigCheck, context(overrides));
      expect(result.status).toBe("warn");
      expect(result.detail).toContain(`ai-worker: the report cannot be matched to the service (${reason})`);
    });

    it("matches systemd's MainPID on Linux", async () => {
      expect((await only(shippedConfigCheck, context({ platform: "linux", commands: { [SYSTEMCTL]: ran("MainPID=4242\n") } }))).status).toBe("ok");
      const other = await only(shippedConfigCheck, context({ platform: "linux", commands: { [SYSTEMCTL]: ran("MainPID=99\n") } }));
      expect(other.detail).toContain("the service runs PID 99");
    });
  });

  it("speaks Chinese in a Chinese report", async () => {
    const result = await only(shippedConfigCheck, makeContext({ ai: host, probes: { shippedConfigReports: async () => shippedReports({ runner: null }) } }));
    expect(result.status).toBe("warn");
    expect(result.detail).not.toContain("has not reported");
  });
});
