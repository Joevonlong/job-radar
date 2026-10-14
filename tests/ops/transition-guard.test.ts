// The safety rails of the upgrade transition (tests/transition/run.sh): the environment cleaning, the docker guard and
// the compose / mount check. Only fake docker binaries run here; nothing reaches a real Docker.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repo = path.resolve(import.meta.dirname, "../..");
const dir = path.join(repo, "tests/transition");
const check = path.join(dir, "compose-check.mjs");
const guard = path.join(dir, "docker-guard.sh");

const PREFIX = "jrtransition-test1234-";
const PROJECT = `${PREFIX}a`;
const PROD_VOLUME = "job-radar_pgdata";

// What the caller's shell might export: each of these would point a test project at something that is not the run's.
const HOSTILE: Record<string, string> = {
  JOBRADAR_PG_VOLUME: PROD_VOLUME,
  COMPOSE_FILE: "/elsewhere/compose.yaml",
  COMPOSE_PROJECT_NAME: "job-radar",
  COMPOSE_PROFILES: "all",
  DOCKER_HOST: "tcp://127.0.0.1:1",
  DOCKER_CONTEXT: "production",
  DB_HOST_PORT: "5433",
  JOB_RADAR_WEB_PORT: "3000",
  JOB_RADAR_BUILD_CONTEXT: "/elsewhere",
  POSTGRES_PASSWORD: "not-this-one",
  PGHOST: "127.0.0.1",
  DATABASE_URL: "postgres://x@127.0.0.1:5433/jobradar",
  RUNNER_HEARTBEAT_SECONDS: "1",
  NODE_OPTIONS: "--require /elsewhere/hook.js",
};

let tmp = "";
let root = "";
beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "transition-guard-")));
  root = path.join(tmp, "transition.run");
  fs.mkdirSync(path.join(root, "projects"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", `${PROJECT}.ports`), "41001\n41002\n");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A compose config (as `docker compose config --format json` prints it) of the project in <root>/a. */
function config(over: { volumeName?: string; external?: boolean; bind?: string; containerName?: string; port?: string; context?: string; name?: string } = {}) {
  const base = path.join(root, "a");
  return {
    name: over.name ?? PROJECT,
    services: {
      db: {
        volumes: [{ type: "volume", source: "jobradar-pg", target: "/var/lib/postgresql/data" }],
        ports: [{ host_ip: "127.0.0.1", target: 5432, published: over.port ?? "41001" }],
        ...(over.containerName ? { container_name: over.containerName } : {}),
      },
      web: {
        build: { context: over.context ?? base, target: "web" },
        volumes: [
          { type: "bind", source: over.bind ?? path.join(base, "data/config"), target: "/app/data/config" },
          { type: "tmpfs", target: "/tmp" },
        ],
        ports: [{ host_ip: "127.0.0.1", target: 3000, published: "41002" }],
      },
    },
    volumes: { "jobradar-pg": { name: over.volumeName ?? `${PROJECT}-pg`, ...(over.external ? { external: true } : {}) } },
  };
}

function runCheck(mode: "config" | "inspect", input: unknown, project = PROJECT) {
  const args = [check, mode, project, PREFIX, root, ...(mode === "config" ? [path.join(root, "projects", `${project}.ports`)] : [])];
  return spawnSync(process.execPath, args, { input: JSON.stringify(input), encoding: "utf8" });
}

describe("compose-check.mjs config", () => {
  it("passes the run's own project", () => {
    const r = runCheck("config", config());
    expect(r.status, r.stderr).toBe(0);
  });
  it.each([
    ["the production volume", { volumeName: PROD_VOLUME }, `named ${PROD_VOLUME}`],
    ["the default global volume", { volumeName: "jobradar-pg" }, "named jobradar-pg"],
    ["an external volume", { external: true }, "is external"],
    ["a bind mount outside the run", { bind: "/Users/someone/job-radar/data/config" }, "outside"],
    ["a build context outside the run", { context: "/Users/someone/job-radar" }, "builds from"],
    ["a fixed container name", { containerName: "job-radar-db-1" }, "container_name"],
    ["the production database port", { port: "5433" }, "publishes port 5433"],
    ["another project's configuration", { name: "job-radar" }, "of project job-radar"],
  ])("refuses %s", (_what, over, reason) => {
    const r = runCheck("config", config(over));
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(reason);
  });
  it("refuses a project without the run's prefix, and one without registered ports", () => {
    expect(runCheck("config", { ...config(), name: "job-radar" }, "job-radar").stderr).toContain("is not named");
    const r = runCheck("config", { ...config(), name: `${PREFIX}b` }, `${PREFIX}b`);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no ports were registered");
  });
});

describe("compose-check.mjs inspect", () => {
  const container = (mounts: object[]) => ({ Name: "/c", Config: { Labels: { "com.docker.compose.project": PROJECT } }, Mounts: mounts });
  it("passes the run's volume, an anonymous one and binds inside the run", () => {
    const r = runCheck("inspect", [
      container([
        { Type: "volume", Name: `${PROJECT}-pg` },
        { Type: "volume", Name: "a".repeat(64) },
        { Type: "bind", Source: path.join(root, "a/data") },
      ]),
    ]);
    expect(r.status, r.stderr).toBe(0);
  });
  it("refuses a container that mounts the production volume or a host path outside the run", () => {
    const r = runCheck("inspect", [container([{ Type: "volume", Name: PROD_VOLUME }, { Type: "bind", Source: "/Users/someone/job-radar/data" }])]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`mounts volume ${PROD_VOLUME}`);
    expect(r.stderr).toContain("outside");
  });
});

describe("docker-guard.sh", () => {
  let fake = "";
  let log = "";
  beforeAll(() => {
    // A fake docker: logs every call, and answers `compose … config --format json` like compose does, with the shell's
    // JOBRADAR_PG_VOLUME beating the project's default.
    fake = path.join(tmp, "fake-docker");
    log = path.join(tmp, "fake-docker.log");
    const cfg = JSON.stringify(config()).replace(`"${PROJECT}-pg"`, '"VOLUME"');
    fs.writeFileSync(
      fake,
      `#!/usr/bin/env bash\necho "$*" >> '${log}'\nif [[ " $* " == *" config --format json"* ]]; then\n  v="\${JOBRADAR_PG_VOLUME:-${PROJECT}-pg}"\n  printf '%s\\n' '${cfg}' | sed "s/\\"VOLUME\\"/\\"$v\\"/"\nfi\nexit 0\n`,
      { mode: 0o755 },
    );
  });

  function runGuard(args: string[], extra: Record<string, string> = {}) {
    fs.writeFileSync(log, "");
    const env: Record<string, string> = {
      PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      HOME: tmp,
      TRANSITION_REAL_DOCKER: fake,
      TRANSITION_PREFIX: PREFIX,
      TRANSITION_ROOT: root,
      TRANSITION_FAIL_FLAG: path.join(root, "fail-flag"),
      ...extra,
    };
    const r = spawnSync("/bin/bash", [guard, ...args], { encoding: "utf8", env: env as NodeJS.ProcessEnv });
    return { ...r, calls: fs.readFileSync(log, "utf8").split("\n").filter(Boolean) };
  }

  it("starts the run's project when its configuration is the run's", () => {
    const r = runGuard(["compose", "-p", PROJECT, "up", "-d"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.calls).toEqual([`compose -p ${PROJECT} config --format json`, `compose -p ${PROJECT} up -d`]);
  });

  it("refuses to start it when the environment points it at the production volume, and never runs the command", () => {
    const r = runGuard(["compose", "-p", PROJECT, "up", "-d"], { JOBRADAR_PG_VOLUME: PROD_VOLUME });
    expect(r.status).toBe(97);
    expect(r.stderr).toContain(`named ${PROD_VOLUME}`);
    expect(r.calls).toEqual([`compose -p ${PROJECT} config --format json`]);
  });

  it("checks the project named by COMPOSE_PROJECT_NAME the same way", () => {
    const r = runGuard(["compose", "build"], { COMPOSE_PROJECT_NAME: PROJECT, JOBRADAR_PG_VOLUME: PROD_VOLUME });
    expect(r.status).toBe(97);
    expect(r.calls).toEqual([`compose -p ${PROJECT} config --format json`]);
  });

  it.each([
    [["compose", "-p", "job-radar", "up", "-d"]],
    [["compose", "up", "-d"]],
    [["compose", "-p", PROJECT, "down", "-v"]],
    [["compose", "-p", `${PREFIX}unregistered`, "up", "-d"]],
    [["volume", "rm", PROD_VOLUME]],
    [["system", "prune", "-af"]],
    [["image", "prune", "-f"]],
    [["builder", "prune", "-f"]],
    [["rm", "-f", "job-radar-db-1"]],
    [["run", "--rm", "-v", `${PROD_VOLUME}:/x`, "alpine"]],
  ])("refuses docker %j without running anything", (args) => {
    const r = runGuard(args, { COMPOSE_PROJECT_NAME: "" });
    expect(r.status).toBe(97);
    expect(r.stderr).toContain("refused");
    expect(r.calls).toEqual([]);
  });

  it("lets read-only commands through", () => {
    expect(runGuard(["ps", "-q"]).calls).toEqual(["ps -q"]);
    expect(runGuard(["compose", "-p", "job-radar", "ps"]).calls).toEqual(["compose -p job-radar ps"]);
  });

  it("refuses everything when it is not configured", () => {
    const r = runGuard(["ps"], { TRANSITION_PREFIX: "job-radar-" });
    expect(r.status).toBe(97);
    expect(r.calls).toEqual([]);
  });
});

describe("clean-env.sh and run.sh", () => {
  it("transition_clean_env unsets every compose, docker and database variable of the caller", () => {
    const r = spawnSync(
      "/bin/bash",
      ["-c", `source '${path.join(dir, "clean-env.sh")}'; transition_clean_env < '${path.join(repo, "compose.yaml")}'; env`],
      { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: tmp, ...HOSTILE } as Record<string, string> as NodeJS.ProcessEnv },
    );
    expect(r.status, r.stderr).toBe(0);
    const left = r.stdout.split("\n").map((l) => l.split("=")[0]);
    for (const name of Object.keys(HOSTILE)) expect(left, name).not.toContain(name);
    expect(left).toContain("HOME");
    expect(r.stderr).toContain("ignoring JOBRADAR_PG_VOLUME from the environment");
  });

  it("run.sh calls docker only after the caller's variables are gone", () => {
    // A docker that records its environment and has no compose: run.sh stops at its first docker call, before it
    // creates anything.
    const bin = path.join(tmp, "run-bin");
    const envLog = path.join(tmp, "run-docker-env.log");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "docker"), `#!/usr/bin/env bash\nenv >> '${envLog}'\nexit 1\n`, { mode: 0o755 });
    const r = spawnSync("/bin/bash", [path.join(dir, "run.sh"), "--scenarios", "A"], {
      encoding: "utf8",
      env: { ...process.env, ...HOSTILE, PATH: `${bin}:${process.env.PATH}` },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docker compose (v2) is not available");
    const seen = fs.readFileSync(envLog, "utf8").split("\n").map((l) => l.split("=")[0]);
    expect(seen.length).toBeGreaterThan(1);
    for (const name of Object.keys(HOSTILE)) expect(seen, name).not.toContain(name);
  });
});
