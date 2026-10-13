import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const dockerfile = readFileSync(path.join(root, "Dockerfile"), "utf8");
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
  devDependencies: Record<string, string>;
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

  it("the runner's FAIL_RUNNER_BUILD test hook is empty by default (a normal build never fails on it)", () => {
    const runner = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(runner).toMatch(/^ARG FAIL_RUNNER_BUILD=""$/m);
    expect(runner).toMatch(/^RUN if \[ -n "\$FAIL_RUNNER_BUILD" \]; then .*false; fi$/m);
  });

  it("defines the web and runner targets", () => {
    expect(dockerfile).toMatch(/AS web\b/);
    expect(dockerfile).toMatch(/AS runner\b/);
  });
});
