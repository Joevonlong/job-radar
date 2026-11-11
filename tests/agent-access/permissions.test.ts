import { describe, expect, it } from "vitest";

import { DATA_AREAS, DEFAULT_PERMISSIONS, effectivePermissions, isPermission, PERMISSIONS, PERMISSION_PRESETS, permissionSchema } from "@/lib/agent-access/permissions";

const catalog = [
  "jobs:read", "raw:read", "tracking:read", "tracking:write", "notes:read", "notes:write", "match:read", "profile:read", "profile:write", "career:read",
  "career:write", "writer:read", "writer:write", "replies:read", "replies:write", "ops:read", "config:read", "config:write", "actions:run", "jobs:import",
];

describe("permission catalog", () => {
  it("contains exactly the twenty permissions in catalog order", () => {
    expect(PERMISSIONS).toEqual(catalog);
    expect(DATA_AREAS).toEqual(["jobs", "raw", "tracking", "notes", "match", "profile", "career", "writer", "replies", "ops", "config"]);
    expect(DEFAULT_PERMISSIONS).toEqual(["jobs:read", "tracking:read"]);
  });

  it("recognizes only catalog permissions at the boundary", () => {
    for (const permission of catalog) {
      expect(isPermission(permission)).toBe(true);
      expect(permissionSchema.parse(permission)).toBe(permission);
    }
    for (const permission of ["jobs:write", "raw:write", "ops:write", "unknown:read", "jobs"]) {
      expect(isPermission(permission)).toBe(false);
      expect(permissionSchema.safeParse(permission).success).toBe(false);
    }
  });

  it("provides ordered read-only, assistant and all presets", () => {
    const reads = ["jobs:read", "tracking:read", "notes:read", "match:read", "profile:read", "career:read", "writer:read", "replies:read", "ops:read", "config:read"];
    const writes = ["tracking:write", "notes:write", "career:write", "writer:write", "replies:write"];
    expect(PERMISSION_PRESETS.read_only).toEqual(reads);
    expect(PERMISSION_PRESETS.read_only).not.toContain("raw:read");
    expect(PERMISSION_PRESETS.read_only.some((permission) => permission.endsWith(":write"))).toBe(false);
    expect(PERMISSION_PRESETS.assistant).toEqual(catalog.filter((permission) => reads.includes(permission) || writes.includes(permission)));
    expect(PERMISSION_PRESETS.assistant.filter((permission) => !reads.includes(permission))).toEqual(writes);
    expect(PERMISSION_PRESETS.all).toEqual(catalog);
  });
});

describe("effectivePermissions", () => {
  it("intersects grants and the global matrix", () => {
    expect([...effectivePermissions(["jobs:read", "tracking:read"], new Set(["jobs:read", "notes:write"]))]).toEqual(["jobs:read"]);
    expect([...effectivePermissions(["tracking:read"], ["notes:write"])]).toEqual([]);
  });

  it("accepts empty grants, an empty matrix, or both", () => {
    expect([...effectivePermissions([], PERMISSIONS)]).toEqual([]);
    expect([...effectivePermissions(PERMISSIONS, [])]).toEqual([]);
    expect([...effectivePermissions([], [])]).toEqual([]);
  });
});
