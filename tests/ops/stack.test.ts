// @vitest-environment node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

import { parse } from "yaml";
import { describe, expect, it } from "vitest";

import { configRegistry } from "@/lib/config";

import { shippedYaml } from "../config/helpers";

const root = path.resolve(import.meta.dirname, "..", "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

interface ComposeService {
  image?: string;
  restart?: string;
  logging?: { driver?: string; options?: Record<string, string> };
  healthcheck?: { test?: string[]; interval?: string; timeout?: string; retries?: number; start_period?: string };
  environment?: Record<string, string>;
  volumes?: Array<string | { source?: string; target?: string }>;
  ports?: string[];
  user?: string;
  security_opt?: string[];
  cap_drop?: string[];
  read_only?: boolean;
  tmpfs?: string[];
  mem_limit?: string;
}
// merge: the `<<: *hardening` keys, as docker compose reads them
const compose = parse(read("compose.yaml"), { merge: true }) as { name?: string; services: Record<string, ComposeService>; volumes?: Record<string, { name?: string }> };
const dockerfile = read("Dockerfile");
const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };

describe("compose.yaml: restart, logging and healthchecks", () => {
  const services = Object.entries(compose.services);

  it("has the four services", () => {
    expect(services.map(([name]) => name).sort()).toEqual(["db", "jobspy", "runner", "web"]);
  });

  it.each(services)("%s restarts unless stopped", (_name, service) => {
    expect(service.restart).toBe("unless-stopped");
  });

  it.each(services)("%s rotates its json-file logs", (_name, service) => {
    expect(service.logging?.driver).toBe("json-file");
    expect(service.logging?.options?.["max-size"]).toBeTruthy();
    expect(service.logging?.options?.["max-file"]).toBeTruthy();
  });

  it.each(services)("%s has a healthcheck", (_name, service) => {
    expect(service.healthcheck?.test?.length).toBeGreaterThan(0);
  });

  it("the runner healthcheck runs the bundled heartbeat check, with room to fail before it reports unhealthy", () => {
    const check = compose.services.runner?.healthcheck;
    expect(check?.test).toEqual(["CMD", "node", "dist/healthcheck.mjs"]);
    expect(check?.retries).toBeGreaterThanOrEqual(2);
    expect(check?.start_period).toBeTruthy();
    // the limit must be several heartbeats long, or one slow beat flips the container
    const env = compose.services.runner?.environment ?? {};
    expect(env.RUNNER_HEALTH_MAX_AGE_SECONDS).toContain("120");
    expect(env.RUNNER_HEARTBEAT_SECONDS).toContain("30");
  });

  it("the runner writes backups into a bind mount the host can see", () => {
    const volumes = compose.services.runner?.volumes ?? [];
    expect(volumes).toContain("./data/backups:/app/data/backups");
    expect(compose.services.runner?.environment?.RUNNER_BACKUP_DIR).toBe("/app/data/backups");
  });
});

describe("compose.yaml: config layers", () => {
  it("web reads the shipped defaults read-only and writes the user config", () => {
    const web = compose.services.web;
    expect(web?.volumes).toContain("./config:/app/config:ro");
    expect(web?.volumes).toContain("./data/config:/app/data/config");
    expect(web?.environment).toMatchObject({ JOB_RADAR_DEFAULTS_DIR: "/app/config", JOB_RADAR_CONFIG_DIR: "/app/data/config", JOB_RADAR_PROFILE_DIR: "/app/data/profile" });
  });

  it("the runner gets both config directories read-only", () => {
    const runner = compose.services.runner;
    expect(runner?.volumes).toContain("./config:/app/config:ro");
    expect(runner?.volumes).toContain("./data/config:/app/data/config:ro");
    expect(runner?.environment).toMatchObject({ JOB_RADAR_DEFAULTS_DIR: "/app/config", JOB_RADAR_CONFIG_DIR: "/app/data/config" });
  });

  it("no service can write the shipped defaults", () => {
    for (const service of Object.values(compose.services)) {
      for (const volume of service.volumes ?? []) {
        if (typeof volume === "string" && volume.startsWith("./config:")) expect(volume.endsWith(":ro")).toBe(true);
      }
    }
  });
});

describe("Dockerfile and build", () => {
  it("the runner image ships the PostgreSQL client of the database's major version", () => {
    const dbMajor = /^postgres:(\d+)/.exec(compose.services.db?.image ?? "")?.[1];
    const clientMajor = /ARG POSTGRES_CLIENT_VERSION=(\d+)\n/.exec(dockerfile)?.[1];
    expect(dbMajor).toBeTruthy();
    expect(clientMajor).toBe(dbMajor);
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toContain("postgresql-client-${POSTGRES_CLIENT_VERSION}");
    expect(runner.indexOf("postgresql-client-")).toBeLessThan(runner.indexOf("USER pwuser"));
  });

  it("copies the healthcheck bundle into the runner image, and the build produces it", () => {
    expect(dockerfile).toContain("/app/dist/healthcheck.mjs ./dist/healthcheck.mjs");
    expect(pkg.scripts["build:runner"]).toContain("healthcheck=src/runner/healthcheck.ts");
    expect(pkg.scripts["build:runner"]).toContain("runner=src/runner/index.ts");
  });
});

describe("schedule.yaml: backup block", () => {
  const parseSchedule = (edit: (raw: Record<string, unknown>) => void) => {
    const raw = structuredClone(shippedYaml("schedule.yaml"));
    edit(raw);
    return configRegistry.schedule.schema.safeParse(raw);
  };
  const backup = (raw: Record<string, unknown>) => raw.backup as Record<string, unknown>;

  it("ships 03:30 daily with 14 daily and 8 weekly backups", () => {
    const parsed = parseSchedule(() => {});
    expect(parsed.success).toBe(true);
    expect(parsed.data?.backup).toEqual({
      enabled: true,
      cron: "30 3 * * *",
      keep_daily: 14,
      keep_weekly: 8,
      timeout_minutes: 30,
      max_age_hours: 30,
      config_archive: true,
      pre_migrate: true,
      keep_system: 5,
      keep_old_databases: 1,
    });
  });

  it("accepts a schedule.yaml from before the config archive, pre-migration backup and restore keys (they default)", () => {
    const parsed = parseSchedule((raw) => {
      for (const key of ["config_archive", "pre_migrate", "keep_system", "keep_old_databases"]) delete backup(raw)[key];
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.backup).toMatchObject({ config_archive: true, pre_migrate: true, keep_system: 5, keep_old_databases: 1 });
  });

  it("rejects a bad cron, a zero daily count, a negative weekly count and unknown keys", () => {
    for (const edit of [
      (raw: Record<string, unknown>) => (backup(raw).cron = "30 25 * * *"),
      (raw: Record<string, unknown>) => (backup(raw).keep_daily = 0),
      (raw: Record<string, unknown>) => (backup(raw).keep_weekly = -1),
      (raw: Record<string, unknown>) => (backup(raw).timeout_minutes = 0),
      (raw: Record<string, unknown>) => (backup(raw).oops = true),
      (raw: Record<string, unknown>) => delete raw.backup,
    ]) {
      expect(parseSchedule(edit).success).toBe(false);
    }
  });

  it("accepts weekly backups switched off", () => {
    expect(parseSchedule((raw) => (backup(raw).keep_weekly = 0)).success).toBe(true);
  });
});

/**
 * One person = one instance; a second instance is a second checkout with its own names (.env). The defaults MUST stay
 * this installation's names: the running install keeps its project, its port and, above all, its database volume.
 */
describe("compose.yaml: instance names and ownership", () => {
  it("defaults to the existing project, volume and port", () => {
    expect(compose.name).toBe("job-radar");
    expect(compose.volumes?.["jobradar-pg"]?.name).toBe("${JOBRADAR_PG_VOLUME:-jobradar-pg}");
    expect(compose.services.web?.ports).toEqual(["${JOB_RADAR_WEB_BIND:-127.0.0.1}:${JOB_RADAR_WEB_PORT:-3000}:3000"]);
    expect(compose.services.web?.environment?.JOB_RADAR_WEB_BIND).toBe("${JOB_RADAR_WEB_BIND:-127.0.0.1}");
  });

  it.each(["web", "runner", "jobspy"])("%s drops every capability and cannot gain privileges", (name) => {
    expect(compose.services[name]?.cap_drop).toEqual(["ALL"]);
    expect(compose.services[name]?.security_opt).toContain("no-new-privileges:true");
  });

  it("web and jobspy run read-only with tmpfs for what they write; runner and jobspy have memory caps", () => {
    expect(compose.services.web?.read_only).toBe(true);
    expect(compose.services.web?.tmpfs).toEqual(expect.arrayContaining(["/tmp", "/app/.next/cache:mode=1777"]));
    expect(compose.services.jobspy?.read_only).toBe(true);
    expect(compose.services.runner?.mem_limit).toBe("${RUNNER_MEM_LIMIT:-2g}");
    expect(compose.services.jobspy?.mem_limit).toBe("${JOBSPY_MEM_LIMIT:-1g}");
    // db keeps what its entrypoint needs (chown, switching to the postgres user)
    expect(compose.services.db?.cap_drop).toBeUndefined();
  });

  it("the web password and the session key never reach the runner or jobspy", () => {
    for (const name of ["JOB_RADAR_WEB_PASSWORD", "JOB_RADAR_WEB_PASSWORD_HASH", "JOB_RADAR_SESSION_SECRET"]) {
      expect(compose.services.runner?.environment?.[name], name).toBe("");
    }
    // jobspy reads no .env at all
    expect((compose.services.jobspy as { env_file?: unknown } | undefined)?.env_file).toBeUndefined();
  });

  it("web and runner run as the same PUID:PGID (the runner reads the 0600 config files the web writes)", () => {
    expect(compose.services.web?.user).toBe("${PUID:-1000}:${PGID:-1000}");
    expect(compose.services.runner?.user).toBe(compose.services.web?.user);
  });

  // `docker compose config` only renders the file (read-only); skipped where docker is not installed.
  const docker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  const render = (env: Record<string, string>) => {
    const out = spawnSync("docker", ["compose", "-f", "compose.yaml", "--env-file", "/dev/null", "config", "--format", "json"], {
      cwd: root,
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    if (out.status !== 0) throw new Error(out.stderr);
    return JSON.parse(out.stdout) as { name: string; volumes: Record<string, { name: string }>; services: Record<string, { ports?: Array<{ host_ip?: string; published: string }>; user?: string }> };
  };

  it.skipIf(docker.status !== 0)("the rendered default keeps the volume jobradar-pg, project job-radar and 127.0.0.1:3000", () => {
    const rendered = render({});
    expect(rendered.name).toBe("job-radar");
    expect(rendered.volumes["jobradar-pg"]?.name).toBe("jobradar-pg");
    expect(rendered.services.web?.ports?.[0]).toMatchObject({ host_ip: "127.0.0.1", published: "3000" });
    expect(rendered.services.web?.user).toBe("1000:1000");
  });

  it.skipIf(docker.status !== 0)("a second instance renders its own names", () => {
    const rendered = render({ COMPOSE_PROJECT_NAME: "job-radar-b", JOBRADAR_PG_VOLUME: "jobradar-b-pg", JOB_RADAR_WEB_PORT: "3100", PUID: "1001", PGID: "1002" });
    expect(rendered.name).toBe("job-radar-b");
    expect(rendered.volumes["jobradar-pg"]?.name).toBe("jobradar-b-pg");
    expect(rendered.services.web?.ports?.[0]).toMatchObject({ host_ip: "127.0.0.1", published: "3100" });
    expect(rendered.services.runner?.user).toBe("1001:1002");
  });
});
