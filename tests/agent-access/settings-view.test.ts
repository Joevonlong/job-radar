import { describe, expect, it } from "vitest";

import { mcpAddress, toolsByPermission } from "@/lib/agent-access/settings-view";
import { CAPABILITIES } from "@/lib/capabilities/registry";

describe("toolsByPermission", () => {
  it("counts the tools of the registry, and a capability added to it is counted under its permission", () => {
    const before = toolsByPermission();
    const total = Object.values(before).reduce((sum, ids) => sum + ids.length, 0);
    expect(total).toBe(CAPABILITIES.length);
    const after = toolsByPermission([...CAPABILITIES, { id: "test_only_capability", permission: "ops:read" }]);
    expect(after["ops:read"]).toEqual([...before["ops:read"], "test_only_capability"]);
    expect(after["jobs:read"]).toEqual(before["jobs:read"]);
  });
});

describe("mcpAddress", () => {
  it("uses the scheme and host the request reached the page with", () => {
    expect(mcpAddress(new Headers({ host: "127.0.0.1:3000" }))).toBe("http://127.0.0.1:3000/api/mcp");
    expect(mcpAddress(new Headers({ host: "web:3000", "x-forwarded-host": "box.example-tailnet.ts.net", "x-forwarded-proto": "https" }))).toBe("https://box.example-tailnet.ts.net/api/mcp");
  });
});
