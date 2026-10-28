import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
  packageManager: string;
};

describe("Dockerfile", () => {
  it("pins the Playwright base image to the @playwright/test version", () => {
    const declared = pkg.devDependencies["@playwright/test"]?.replace(/^[\^~]/, "");
    const installed = (
      JSON.parse(readFileSync(path.join(root, "node_modules/@playwright/test/package.json"), "utf8")) as { version: string }
    ).version;
    const arg = /ARG PLAYWRIGHT_VERSION=(\S+)/.exec(dockerfile)?.[1];
    expect(arg).toBe(installed);
    expect(declared?.split(".")[0]).toBe(installed.split(".")[0]);
  });

  it("pins the AI CLIs to exact versions (the fixtures in tests/fixtures/ai are recorded against them)", () => {
    expect(dockerfile).toMatch(/ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+\n/);
    expect(dockerfile).toMatch(/ARG CODEX_VERSION=\d+\.\d+\.\d+\n/);
    expect(dockerfile).toMatch(/npm install -g @anthropic-ai\/claude-code@\$\{CLAUDE_CODE_VERSION\} @openai\/codex@\$\{CODEX_VERSION\}/);
    // installed as root, before the runner drops to pwuser
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner.indexOf("npm install -g @anthropic-ai/claude-code")).toBeGreaterThan(-1);
    expect(runner.indexOf("npm install -g @anthropic-ai/claude-code")).toBeLessThan(runner.indexOf("USER pwuser"));
  });

  it("installs the PostgreSQL client in the runner image (pg_dump and pg_restore for backup and restore)", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toMatch(/apt-get install -y --no-install-recommends postgresql-client-\$\{POSTGRES_CLIENT_VERSION\}/);
    expect(runner.indexOf("postgresql-client-")).toBeLessThan(runner.indexOf("USER pwuser"));
  });

  describe.each(["web", "runner"])("the %s stage ships the defaults from config/", (target) => {
    const start = dockerfile.indexOf(`AS ${target}\n`);
    const next = dockerfile.indexOf("\nFROM ", start);
    const stage = dockerfile.slice(start, next === -1 ? undefined : next);
    const user = stage.search(/^USER /m);

    it("copies config/ into /app/config and points JOB_RADAR_DEFAULTS_DIR at it", () => {
      expect(stage).toMatch(/^ENV JOB_RADAR_DEFAULTS_DIR=\/app\/config$/m);
      expect(stage).toMatch(/^COPY config\/ \/app\/config\/$/m);
    });

    it("makes it readable by every uid and writable by none but root, before switching user", () => {
      const chmod = stage.search(/^RUN chmod -R a\+rX,go-w \/app\/config$/m);
      expect(chmod).toBeGreaterThan(stage.search(/^COPY config\/ /m));
      expect(user).toBeGreaterThan(chmod);
    });
  });

  it("the web stage drops the copy of config/ that Next's standalone output brings (owned by node) before copying its own", () => {
    const web = dockerfile.slice(dockerfile.indexOf("AS web\n"), dockerfile.indexOf("\nFROM ", dockerfile.indexOf("AS web\n")));
    const rm = web.search(/^RUN rm -rf \/app\/config$/m);
    expect(rm).toBeGreaterThan(web.search(/^COPY --from=build --chown=node:node \/app\/\.next\/standalone /m));
    expect(web.search(/^COPY config\/ /m)).toBeGreaterThan(rm);
  });

  it("the runner's FAIL_RUNNER_BUILD test hook is empty by default (a normal build never fails on it)", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toMatch(/^ARG FAIL_RUNNER_BUILD=""$/m);
    expect(runner).toMatch(/^RUN if \[ -n "\$FAIL_RUNNER_BUILD" \]; then .*false; fi$/m);
  });

  describe("checks the running Node against engines.node", () => {
    const stageOf = (target: string): string => {
      const start = dockerfile.indexOf(`AS ${target}\n`);
      const next = dockerfile.indexOf("\nFROM ", start);
      return dockerfile.slice(start, next === -1 ? undefined : next);
    };

    it("in the build stage, right after the sources are copied", () => {
      const build = stageOf("build");
      const copy = build.search(/^COPY \. \.$/m);
      const check = build.search(/^RUN node scripts\/ops\/check-node-engines\.mjs package\.json$/m);
      expect(copy).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(copy);
      expect(build.search(/^RUN --network=none pnpm build /m)).toBeGreaterThan(check);
    });

    it.each(["web", "runner"])("in the final %s stage, before switching user", (target) => {
      const stage = stageOf(target);
      const copy = stage.search(/^COPY --from=build \/app\/package\.json \/app\/scripts\/ops\/check-node-engines\.mjs \/tmp\/engines\/$/m);
      const check = stage.search(
        /^RUN node \/tmp\/engines\/check-node-engines\.mjs \/tmp\/engines\/package\.json && rm -rf \/tmp\/engines$/m,
      );
      expect(copy).toBeGreaterThan(-1);
      expect(check).toBeGreaterThan(copy);
      expect(stage.search(/^USER /m)).toBeGreaterThan(check);
    });

    it("in the runner, after its Node binary is replaced", () => {
      const runner = stageOf("runner");
      expect(runner.search(/^RUN node \/tmp\/engines\//m)).toBeGreaterThan(runner.search(/^COPY --from=node22 /m));
    });

    it("every final stage (each stage that switches user) runs the check", () => {
      const stages = dockerfile.split(/\n(?=FROM )/).filter((s) => /^USER /m.test(s));
      expect(stages.length).toBeGreaterThanOrEqual(2);
      for (const s of stages) expect(s).toMatch(/check-node-engines\.mjs/);
    });
  });

  describe("compiles without network access", () => {
    const build = dockerfile.slice(dockerfile.indexOf("AS build\n"), dockerfile.indexOf("\nFROM ", dockerfile.indexOf("AS build\n")));

    it("runs the web and runner builds with --network=none", () => {
      expect(build).toMatch(/^RUN --network=none pnpm build && pnpm build:runner$/m);
      // the only build commands of the stage
      expect(build.match(/pnpm build/g)).toHaveLength(2);
    });

    it("starts from no .next cache (a cached copy could hide a network lookup)", () => {
      expect(build).not.toMatch(/target=[^\s,]*\.next/);
      const dockerignore = readFileSync(path.join(root, ".dockerignore"), "utf8");
      expect(dockerignore).toMatch(/^\*\*\/\.next$/m);
    });

    it("installs the pnpm version package.json names (otherwise pnpm may download its own at build time)", () => {
      const arg = /ARG PNPM_VERSION=(\S+)/.exec(dockerfile)?.[1];
      expect(pkg.packageManager).toBe(`pnpm@${arg}`);
    });
  });

  it("the web stage ships the licences of the font files it serves", () => {
    const web = dockerfile.slice(dockerfile.indexOf("AS web\n"), dockerfile.indexOf("\nFROM ", dockerfile.indexOf("AS web\n")));
    expect(web).toMatch(/^COPY licenses\/fonts\/ \/app\/licenses\/fonts\/$/m);
    expect(web.search(/^USER /m)).toBeGreaterThan(web.search(/^COPY licenses\/fonts\//m));
    expect(readFileSync(path.join(root, ".dockerignore"), "utf8")).not.toMatch(/^licenses/m);
  });

  it("defines the web and runner targets", () => {
    expect(dockerfile).toMatch(/AS web\b/);
    expect(dockerfile).toMatch(/AS runner\b/);
  });
});

describe("jobspy/Dockerfile and the sidecar's lock files", () => {
  const jobspy = (file: string): string => readFileSync(path.join(root, "jobspy", file), "utf8");
  const sidecar = jobspy("Dockerfile");
  const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, "-");
  /** `name==version` lines of a requirements file (comments, options and hash lines left out). */
  const pins = (text: string): Map<string, string> =>
    new Map([...text.matchAll(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/gm)].map((m) => [normalize(m[1]!), m[2]!]));
  /** One entry per pinned package: the `name==version` line and the `--hash` lines that continue it. */
  const entries = (text: string): string[] => text.split(/\n(?=[A-Za-z0-9])/).filter((block) => /^[A-Za-z0-9]/.test(block));

  it("starts from the Python base image pinned by digest", () => {
    const from = sidecar.match(/^FROM .*$/gm) ?? [];
    expect(from).toHaveLength(1);
    expect(from[0]).toMatch(/^FROM python:3\.12-slim@sha256:[0-9a-f]{64}$/);
  });

  it("installs only the lock file, with --require-hashes", () => {
    expect(sidecar).toMatch(/^COPY requirements\.txt \.$/m);
    const installs = sidecar.match(/pip install.*$/gm) ?? [];
    expect(installs).toEqual(["pip install --require-hashes -r requirements.txt"]);
    expect(sidecar.search(/^RUN pip install/m)).toBeLessThan(sidecar.search(/^USER /m));
  });

  it("CI installs the dev lock file with --require-hashes too", () => {
    const ci = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
    const installs = ci.match(/pip install .*$/gm) ?? [];
    expect(installs).toEqual(["pip install --require-hashes -r requirements-dev.txt"]);
  });

  describe.each([
    ["requirements.in", "requirements.txt"],
    ["requirements-dev.in", "requirements-dev.txt"],
  ])("%s -> %s", (input, lock) => {
    const locked = jobspy(lock);

    it("the lock pins every package with at least one sha256 hash", () => {
      const all = entries(locked);
      expect(all.length).toBeGreaterThan(pins(jobspy(input)).size);
      for (const entry of all) {
        expect(entry, entry.split("\n")[0]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*==\S+/);
        expect(entry, entry.split("\n")[0]).toMatch(/--hash=sha256:[0-9a-f]{64}/);
      }
      expect(locked).not.toMatch(/^\s*-e /m);
    });

    it("was regenerated after the last change: every pin of the input is the version in the lock", () => {
      const direct = pins(jobspy(input));
      expect(direct.size).toBeGreaterThan(0);
      const resolved = pins(locked);
      for (const [name, version] of direct) expect(resolved.get(name), name).toBe(version);
    });
  });

  it("the dev lock keeps every runtime package at the version the image installs", () => {
    const runtime = pins(jobspy("requirements.txt"));
    const dev = pins(jobspy("requirements-dev.txt"));
    for (const [name, version] of runtime) expect(dev.get(name), name).toBe(version);
  });

  it("the build context holds the lock file, not the inputs or the dev lock", () => {
    const ignore = jobspy(".dockerignore");
    expect(ignore).toMatch(/^\*\.in$/m);
    expect(ignore).toMatch(/^requirements-dev\.txt$/m);
    expect(ignore).not.toMatch(/^requirements\.txt$/m);
  });
});
