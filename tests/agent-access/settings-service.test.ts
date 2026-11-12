// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { authorize, liveMcpSettings } from "@/lib/agent-access/authorize";
import { saveAgentMatrix, saveStdioPermissions, setAgentSwitch } from "@/lib/agent-access/settings-service";
import { layeredConfigFingerprint } from "@/lib/config";
import type { OwnerSessionState } from "@/lib/security/owner-session";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const MCP = `config_version: 3

# the owner's own note on the switch
enabled: true

# the owner's own note on the matrix
permissions:
  - jobs:read
  - tracking:read

stdio:
  permissions:
    - jobs:read
    - config:write
`;

let tmp: TempConfig;
const file = () => path.join(tmp.configDir, "mcp.yaml");
const text = () => fs.readFileSync(file(), "utf8");

beforeEach(() => {
  tmp = makeTempConfig();
  fs.writeFileSync(file(), MCP);
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "a long test password");
});
afterEach(() => {
  vi.unstubAllEnvs();
  tmp.cleanup();
});

describe("the session gate", () => {
  it("refuses every change without a session when a password is set, and leaves the file as it was", async () => {
    const baseHash = layeredConfigFingerprint("mcp");
    const results = [
      await setAgentSwitch({ key: "enabled", value: false }, "login_required"),
      await setAgentSwitch({ key: "http", value: true }, "login_required"),
      await saveAgentMatrix({ permissions: ["jobs:read"], baseHash }, "login_required"),
      await saveStdioPermissions({ permissions: ["jobs:read"], baseHash }, "login_required"),
    ];
    expect(results.map((result) => result.status)).toEqual(["session_required", "session_required", "session_required", "session_required"]);
    expect(text()).toBe(MCP);
  });

  it.each<OwnerSessionState>(["ok", "no_password"])("lets a change through with %s", async (session) => {
    const result = await setAgentSwitch({ key: "enabled", value: false }, session);
    expect(result.status).toBe("saved");
    expect(liveMcpSettings().enabled).toBe(false);
  });

  it("checks the request before the session, and takes nothing else from it", async () => {
    expect((await setAgentSwitch({ key: "enabled", value: false, session: "ok" }, "login_required")).status).toBe("invalid");
    expect((await saveAgentMatrix({ permissions: ["nope:read"], baseHash: "x" }, "ok")).status).toBe("invalid");
    expect(text()).toBe(MCP);
  });
});

describe("the switches", () => {
  it("saves the HTTP switch only with a usable web password", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    expect((await setAgentSwitch({ key: "http", value: true }, "no_password")).status).toBe("password_required");
    expect(liveMcpSettings().http.enabled).toBe(false);
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "a long test password");
    expect((await setAgentSwitch({ key: "http", value: true }, "ok")).status).toBe("saved");
    expect(liveMcpSettings().http.enabled).toBe(true);
    expect(text()).toContain("# the owner's own note on the switch");
  });

  it("reports an unreadable file and does not touch it", async () => {
    fs.writeFileSync(file(), "enabled: [oops\n");
    expect((await setAgentSwitch({ key: "enabled", value: true }, "ok")).status).toBe("unreadable");
    expect(text()).toBe("enabled: [oops\n");
  });
});

describe("the global matrix", () => {
  it("saves only the permissions, keeps the comments, and the next call is judged by the new matrix", async () => {
    const search = { id: "search_jobs", permission: "jobs:read" } as const;
    expect(authorize(search, liveMcpSettings).allowed).toBe(true);
    const result = await saveAgentMatrix({ permissions: ["tracking:read"], baseHash: layeredConfigFingerprint("mcp") }, "ok");
    expect(result).toEqual({ status: "saved", baseHash: layeredConfigFingerprint("mcp") });
    expect(liveMcpSettings().permissions).toEqual(["tracking:read"]);
    expect(liveMcpSettings().stdio.permissions).toEqual(["jobs:read", "config:write"]);
    expect(text()).toContain("# the owner's own note on the matrix");
    expect(authorize(search, liveMcpSettings)).toEqual({ allowed: false, reason: "missing_permission", permission: "jobs:read" });
  });

  it("refuses a save against a file that changed since the page read it", async () => {
    const baseHash = layeredConfigFingerprint("mcp");
    fs.writeFileSync(file(), MCP.replace("enabled: true", "enabled: false"));
    const changed = text();
    expect((await saveAgentMatrix({ permissions: ["jobs:read"], baseHash }, "ok")).status).toBe("stale");
    expect(text()).toBe(changed);
  });
});

describe("the local stdio grant", () => {
  it("takes only what the matrix allows and keeps what the file held beyond it", async () => {
    const baseHash = layeredConfigFingerprint("mcp");
    expect((await saveStdioPermissions({ permissions: ["raw:read"], baseHash }, "ok")).status).toBe("not_in_matrix");
    expect(text()).toBe(MCP);
    expect((await saveStdioPermissions({ permissions: ["tracking:read"], baseHash }, "ok")).status).toBe("saved");
    expect(liveMcpSettings().stdio.permissions).toEqual(["tracking:read", "config:write"]);
    expect(liveMcpSettings().permissions).toEqual(["jobs:read", "tracking:read"]);
  });
});
