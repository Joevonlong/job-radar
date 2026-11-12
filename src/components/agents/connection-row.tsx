import type { ReactNode } from "react";

import type { Permission } from "@/lib/agent-access/permissions";

import { PermissionPill } from "./permission-pill";

export function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1" : "flex min-w-0 flex-col gap-1"}>
      <dt className="text-label font-bold text-ink-3">{label}</dt>
      <dd className="min-w-0 text-body-sm">{children}</dd>
    </div>
  );
}

/** One connection: its fields in a grid (two columns on a phone, one row on a wider screen) and its buttons. */
export function ConnectionRow({ children, actions, testId, muted = false }: { children: ReactNode; actions: ReactNode; testId: string; muted?: boolean }) {
  return (
    <li className={muted ? "flex flex-col gap-3 rounded-cell border-bw border-dashed border-border bg-soft px-3 py-3 md:flex-row md:items-start" : "flex flex-col gap-3 rounded-cell border-bw border-border bg-card px-3 py-3 md:flex-row md:items-start"} data-testid={testId}>
      <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1.3fr)_7rem_minmax(0,2fr)_5rem_5rem_6rem]">{children}</dl>
      <div className="flex flex-wrap gap-2 self-start md:w-36 md:flex-col md:items-stretch">{actions}</div>
    </li>
  );
}

export function PermissionPills({ granted, allowed, none }: { granted: Permission[]; allowed: ReadonlySet<Permission>; none: string }) {
  if (granted.length === 0) return <span className="text-ink-3">{none}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {granted.map((permission) => (
        <PermissionPill key={permission} permission={permission} effective={allowed.has(permission)} />
      ))}
    </span>
  );
}
