// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveAgentMatrixAction, saveStdioPermissionsAction, setAgentSwitchAction } from "@/app/settings/agents/actions";
import { resetAdvancedAction, saveAdvancedAction } from "@/app/settings/actions";
import { layeredConfigFingerprint } from "@/lib/config";
import { passwordVersion, readPasswordSetting } from "@/lib/security/password";
import { createSessionToken, resetSessionSecretCache, SESSION_COOKIE, sessionSecret } from "@/lib/security/session";
import { loadAdvancedFile } from "@/lib/settings/advanced/view";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const request = vi.hoisted(() => ({ headers: new Headers(), cookies: new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined) }),
}));

const PASSWORD = "a long test password";

let tmp: TempConfig;
const file = () => path.join(tmp.configDir, "mcp.yaml");

function signedIn() {
  const setting = readPasswordSetting(process.env);
  if (setting === null) throw new Error("no password");
  const secret = sessionSecret(tmp.configDir);
  request.cookies.set(SESSION_COOKIE, createSessionToken(secret, passwordVersion(setting, secret), 3600, new Date()));
}

beforeEach(() => {
  tmp = makeTempConfig();
  fs.writeFileSync(file(), "config_version: 3\nenabled: true\npermissions:\n  - jobs:read\nstdio:\n  permissions:\n    - jobs:read\n");
  request.headers = new Headers({ host: "127.0.0.1:3000" });
  request.cookies = new Map();
  vi.stubEnv("JOB_RADAR_WEB_BIND", "127.0.0.1");
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
  vi.stubEnv("JOB_RADAR_SESSION_SECRET", "");
  resetSessionSecretCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetSessionSecretCache();
  tmp.cleanup();
});

describe("the agent access actions", () => {
  it("a local request without a session cannot change anything once a password is set", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
    const before = fs.readFileSync(file(), "utf8");
    expect(await setAgentSwitchAction({ key: "enabled", value: false })).toEqual({ status: "session_required" });
    expect(await setAgentSwitchAction({ key: "http", value: true })).toEqual({ status: "session_required" });
    expect(await saveStdioPermissionsAction({ permissions: [], baseHash: layeredConfigFingerprint("mcp") })).toEqual({ status: "session_required" });
    expect(await saveAgentMatrixAction({ permissions: ["jobs:read", "raw:read"], baseHash: layeredConfigFingerprint("mcp") })).toEqual({ status: "session_required" });
    const data = loadAdvancedFile("mcp");
    if (!data.ok) throw new Error("not loadable");
    expect(await saveAdvancedAction({ file: "mcp", text: `${data.data.text}# mine\n`, baseHash: data.data.hash, baseLayer: data.data.layer, confirmOverride: false })).toEqual({ status: "session_required" });
    expect(await resetAdvancedAction({ file: "mcp", baseHash: data.data.hash, baseLayer: data.data.layer })).toEqual({ status: "session_required" });
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
  });

  it("the same request with a valid session cookie may change them", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", PASSWORD);
    signedIn();
    expect((await setAgentSwitchAction({ key: "http", value: true })).status).toBe("saved");
    expect((await saveAgentMatrixAction({ permissions: ["jobs:read", "raw:read"], baseHash: layeredConfigFingerprint("mcp") })).status).toBe("saved");
    expect((await saveStdioPermissionsAction({ permissions: ["raw:read"], baseHash: layeredConfigFingerprint("mcp") })).status).toBe("saved");
    expect(fs.readFileSync(file(), "utf8")).toMatch(/stdio:\n\s+permissions:\n\s+- raw:read\n/);
  });

  it("without a password the same request may change them", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    expect((await setAgentSwitchAction({ key: "enabled", value: false })).status).toBe("saved");
    expect((await saveAgentMatrixAction({ permissions: ["jobs:read", "raw:read"], baseHash: layeredConfigFingerprint("mcp") })).status).toBe("saved");
  });
});
