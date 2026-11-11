/**
 * Permissions are <area>:read|write plus two action permissions. A connection's effective permissions are what it was
 * granted intersected with the owner's global matrix.
 */
import { z } from "zod";

export const PERMISSIONS = [
  "jobs:read",
  "raw:read",
  "tracking:read",
  "tracking:write",
  "notes:read",
  "notes:write",
  "match:read",
  "profile:read",
  "profile:write",
  "career:read",
  "career:write",
  "writer:read",
  "writer:write",
  "replies:read",
  "replies:write",
  "ops:read",
  "config:read",
  "config:write",
  "actions:run",
  "jobs:import",
] as const;

export type Permission = (typeof PERMISSIONS)[number];
export const DATA_AREAS = ["jobs", "raw", "tracking", "notes", "match", "profile", "career", "writer", "replies", "ops", "config"] as const;
export const permissionSchema = z.enum(PERMISSIONS);

export function isPermission(value: string): value is Permission {
  return permissionSchema.safeParse(value).success;
}

const readOnly: readonly Permission[] = PERMISSIONS.filter((permission) => permission.endsWith(":read") && permission !== "raw:read");
const assistantWrites: readonly Permission[] = ["tracking:write", "notes:write", "replies:write", "writer:write", "career:write"];
const assistant: readonly Permission[] = PERMISSIONS.filter((permission) => readOnly.includes(permission) || assistantWrites.includes(permission));

export const PERMISSION_PRESETS = {
  read_only: readOnly,
  assistant,
  all: PERMISSIONS,
} as const satisfies Record<string, readonly Permission[]>;

export const DEFAULT_PERMISSIONS = ["jobs:read", "tracking:read"] as const satisfies readonly Permission[];

export function effectivePermissions(granted: Iterable<Permission>, matrix: Iterable<Permission>): ReadonlySet<Permission> {
  const allowed = new Set(matrix);
  return new Set([...granted].filter((permission) => allowed.has(permission)));
}
