// @vitest-environment node
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { saveAgentMatrixAction, setAgentSwitchAction } from "@/app/settings/agents/actions";
import { saveAdvancedAction } from "@/app/settings/actions";
import { layeredConfigFingerprint } from "@/lib/config";
import { loadAdvancedFile } from "@/lib/settings/advanced/view";

import { makeTempConfig, type TempConfig } from "../config/helpers";

const request = vi.hoisted(() => ({ headers: new Headers(), cookies: new Map<string, string>() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn(), revalidateTag: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: async () => request.headers,
  cookies: async () => ({ get: (name: string) => (request.cookies.has(name) ? { name, value: request.cookies.get(name)! } : undefined) }),
}));

let tmp: TempConfig;
const file = () => path.join(tmp.configDir, "mcp.yaml");

beforeEach(() => {
  tmp = makeTempConfig();
  fs.writeFileSync(file(), "config_version: 3\nenabled: true\npermissions:\n  - jobs:read\nstdio:\n  permissions:\n    - jobs:read\n");
  request.headers = new Headers({ host: "127.0.0.1:3000" });
  request.cookies = new Map();
  vi.stubEnv("JOB_RADAR_WEB_BIND", "127.0.0.1");
  vi.stubEnv("JOB_RADAR_WEB_PASSWORD_HASH", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  tmp.cleanup();
});

describe("the agent access actions", () => {
  it("a local request without a session cannot change anything once a password is set", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "a long test password");
    const before = fs.readFileSync(file(), "utf8");
    expect(await setAgentSwitchAction({ key: "enabled", value: false })).toEqual({ status: "session_required" });
    expect(await saveAgentMatrixAction({ permissions: ["jobs:read", "raw:read"], baseHash: layeredConfigFingerprint("mcp") })).toEqual({ status: "session_required" });
    const data = loadAdvancedFile("mcp");
    if (!data.ok) throw new Error("not loadable");
    expect(await saveAdvancedAction({ file: "mcp", text: `${data.data.text}# mine\n`, baseHash: data.data.hash, baseLayer: data.data.layer, confirmOverride: false })).toEqual({ status: "session_required" });
    expect(fs.readFileSync(file(), "utf8")).toBe(before);
  });

  it("without a password the same request may change them", async () => {
    vi.stubEnv("JOB_RADAR_WEB_PASSWORD", "");
    expect((await setAgentSwitchAction({ key: "enabled", value: false })).status).toBe("saved");
    expect((await saveAgentMatrixAction({ permissions: ["jobs:read", "raw:read"], baseHash: layeredConfigFingerprint("mcp") })).status).toBe("saved");
  });
});
