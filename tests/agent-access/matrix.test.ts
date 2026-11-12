import { describe, expect, it } from "vitest";

import { MATRIX_ROWS, PERMISSION_NOTES, ineffectivePermissions, narrowingImpact, normalizePermissions, presetOf, presetSelection, samePermissions } from "@/lib/agent-access/matrix";
import { DATA_AREAS, PERMISSION_PRESETS, PERMISSIONS, type Permission } from "@/lib/agent-access/permissions";

describe("the matrix rows", () => {
  it("has one row per data area and one per action permission, and every permission appears exactly once", () => {
    expect(MATRIX_ROWS).toHaveLength(DATA_AREAS.length + 2);
    const cells = MATRIX_ROWS.flatMap((row) => (row.kind === "area" ? [row.read, row.write] : [row.permission])).filter((cell): cell is Permission => cell !== null);
    expect([...cells].sort()).toEqual([...PERMISSIONS].sort());
  });

  it("leaves out the cells that do not exist", () => {
    const row = (id: string) => MATRIX_ROWS.find((candidate) => candidate.id === id);
    expect(row("jobs")).toMatchObject({ read: "jobs:read", write: null });
    expect(row("raw")).toMatchObject({ read: "raw:read", write: null });
    expect(row("tracking")).toMatchObject({ read: "tracking:read", write: "tracking:write" });
    expect(row("import")).toMatchObject({ kind: "action", permission: "jobs:import" });
  });

  it("notes only permissions that exist", () => {
    for (const permission of Object.keys(PERMISSION_NOTES)) expect(PERMISSIONS).toContain(permission);
  });
});

describe("presets and selections", () => {
  it("orders and deduplicates", () => {
    expect(normalizePermissions(["tracking:read", "jobs:read", "tracking:read"])).toEqual(["jobs:read", "tracking:read"]);
    expect(samePermissions(["tracking:read", "jobs:read"], ["jobs:read", "tracking:read"])).toBe(true);
    expect(samePermissions(["jobs:read"], ["jobs:read", "tracking:read"])).toBe(false);
  });

  it("recognises a preset only when the selection equals it", () => {
    for (const id of Object.keys(PERMISSION_PRESETS) as (keyof typeof PERMISSION_PRESETS)[]) expect(presetOf(PERMISSION_PRESETS[id])).toBe(id);
    expect(presetOf(["jobs:read"])).toBeNull();
  });

  it("limits a preset to what is available", () => {
    const within: Permission[] = ["jobs:read", "raw:read", "tracking:write"];
    expect(presetSelection("all", within)).toEqual(["jobs:read", "raw:read", "tracking:write"]);
    expect(presetSelection("read_only", within)).toEqual(["jobs:read"]);
    expect(presetOf(["jobs:read"], within)).toBe("read_only");
  });

  it("finds granted permissions the matrix does not allow", () => {
    expect(ineffectivePermissions(["jobs:read", "config:write", "raw:read"], ["jobs:read"])).toEqual(["raw:read", "config:write"]);
  });
});

describe("narrowingImpact", () => {
  it("counts the connections that would lose something and the distinct permissions they lose", () => {
    const saved: Permission[] = ["jobs:read", "tracking:read", "notes:read"];
    const next: Permission[] = ["jobs:read"];
    const grants: Permission[][] = [["jobs:read"], ["tracking:read", "notes:read"], ["tracking:read"], []];
    expect(narrowingImpact(saved, next, grants)).toEqual({ connections: 2, permissions: 2 });
  });

  it("widening or a permission no connection holds takes nothing away", () => {
    expect(narrowingImpact(["jobs:read"], ["jobs:read", "raw:read"], [["jobs:read"]])).toEqual({ connections: 0, permissions: 0 });
    expect(narrowingImpact(["jobs:read", "raw:read"], ["jobs:read"], [["jobs:read"]])).toEqual({ connections: 0, permissions: 0 });
  });
});
