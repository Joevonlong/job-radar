/**
 * The permission matrix as the agent access page shows it: one row per data area (a read and a write cell, either of which may not
 * exist) and one row per action permission. Browser-safe: no server imports.
 */
import { DATA_AREAS, PERMISSION_PRESETS, PERMISSIONS, isPermission, type Permission } from "./permissions";

export type DataArea = (typeof DATA_AREAS)[number];
export type PresetId = keyof typeof PERMISSION_PRESETS;
export const PRESET_IDS = Object.keys(PERMISSION_PRESETS) as PresetId[];

export type MatrixRow =
  | { id: DataArea; kind: "area"; read: Permission | null; write: Permission | null }
  | { id: "actions" | "import"; kind: "action"; permission: Permission };

function existing(value: string): Permission | null {
  return isPermission(value) ? value : null;
}

export const MATRIX_ROWS: readonly MatrixRow[] = [
  ...DATA_AREAS.map((area): MatrixRow => ({ id: area, kind: "area", read: existing(`${area}:read`), write: existing(`${area}:write`) })),
  { id: "actions", kind: "action", permission: "actions:run" },
  { id: "import", kind: "action", permission: "jobs:import" },
];

/** What a permission needs the owner to know before granting it: third-party text that was not cleaned, or writes that wait for approval. */
export type PermissionNote = "untrusted" | "approval" | "career";
export const PERMISSION_NOTES: Partial<Record<Permission, PermissionNote>> = {
  "raw:read": "untrusted",
  "profile:write": "approval",
  "config:write": "approval",
  "career:write": "career",
};

/** Unique, in catalogue order. */
export function normalizePermissions(list: Iterable<Permission>): Permission[] {
  const chosen = new Set(list);
  return PERMISSIONS.filter((permission) => chosen.has(permission));
}

export function samePermissions(a: Iterable<Permission>, b: Iterable<Permission>): boolean {
  const left = normalizePermissions(a);
  const right = normalizePermissions(b);
  return left.length === right.length && left.every((permission, i) => permission === right[i]);
}

/** The preset a selection equals exactly, or null. */
export function presetOf(selection: Iterable<Permission>, within: Iterable<Permission> = PERMISSIONS): PresetId | null {
  return PRESET_IDS.find((id) => samePermissions(presetSelection(id, within), selection)) ?? null;
}

/** A preset limited to what is available (the matrix, for a connection's own grant). */
export function presetSelection(id: PresetId, within: Iterable<Permission> = PERMISSIONS): Permission[] {
  const allowed = new Set(within);
  return normalizePermissions(PERMISSION_PRESETS[id].filter((permission) => allowed.has(permission)));
}

/** Granted permissions the matrix does not allow: they are kept but give nothing. */
export function ineffectivePermissions(granted: Iterable<Permission>, matrix: Iterable<Permission>): Permission[] {
  const allowed = new Set(matrix);
  return normalizePermissions([...granted].filter((permission) => !allowed.has(permission)));
}

export interface NarrowingImpact {
  /** Connections that would lose at least one permission they have now. */
  connections: number;
  /** Distinct permissions those connections would lose. */
  permissions: number;
}

/** What saving `next` instead of `saved` takes away from the connections whose own grants are `grants`. */
export function narrowingImpact(saved: Iterable<Permission>, next: Iterable<Permission>, grants: readonly (readonly Permission[])[]): NarrowingImpact {
  const kept = new Set(next);
  const removed = new Set([...saved].filter((permission) => !kept.has(permission)));
  const lost = new Set<Permission>();
  let connections = 0;
  for (const grant of grants) {
    const losing = grant.filter((permission) => removed.has(permission));
    if (losing.length === 0) continue;
    connections += 1;
    for (const permission of losing) lost.add(permission);
  }
  return { connections, permissions: lost.size };
}
