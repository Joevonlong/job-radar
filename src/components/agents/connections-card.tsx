"use client";

import { Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Permission } from "@/lib/agent-access/permissions";

import { PermissionPill } from "./permission-pill";
import { StdioDialog } from "./stdio-dialog";

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1" : "flex min-w-0 flex-col gap-1"}>
      <dt className="text-label font-bold text-ink-3">{label}</dt>
      <dd className="min-w-0 text-body-sm">{children}</dd>
    </div>
  );
}

/**
 * Everything that can connect, first the local stdio process (it has no token; its grant lives in mcp.yaml). Each row shows its
 * grant, with what the matrix does not allow drawn as giving nothing. The stdio grant is edited in a dialog that lists only what the
 * matrix allows.
 */
export function ConnectionsCard({ stdio, matrix, baseHash, locked }: { stdio: Permission[]; matrix: Permission[]; baseHash: string | null; locked: boolean }) {
  const t = useTranslations("agents.connections");
  const [editing, setEditing] = useState(false);
  const allowed = new Set(matrix);
  return (
    <Card data-testid="agents-connections-card">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3">
          <li className="flex flex-col gap-3 rounded-cell border-bw border-border bg-card px-3 py-3 md:flex-row md:items-start" data-testid="connection-stdio">
            <dl className="grid min-w-0 flex-1 grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1.3fr)_5rem_minmax(0,2fr)_5rem_5rem_6rem]">
              <Field label={t("columns.name")} wide>
                <span className="flex items-center gap-1.5 font-bold">
                  <Terminal aria-hidden className="size-4 flex-none" />
                  {t("stdio.name")}
                </span>
              </Field>
              <Field label={t("columns.prefix")}>
                <span className="font-mono text-ink-3">—</span>
              </Field>
              <Field label={t("columns.permissions")} wide>
                {stdio.length === 0 ? (
                  <span className="text-ink-3">{t("none")}</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {stdio.map((permission) => (
                      <PermissionPill key={permission} permission={permission} effective={allowed.has(permission)} />
                    ))}
                  </span>
                )}
              </Field>
              <Field label={t("columns.created")}>
                <span className="font-mono text-ink-3">—</span>
              </Field>
              <Field label={t("columns.lastUsed")}>
                <span className="font-mono text-ink-3">—</span>
              </Field>
              <Field label={t("columns.expires")}>{t("noExpiry")}</Field>
            </dl>
            <Button type="button" size="sm" disabled={locked || baseHash === null} onClick={() => setEditing(true)} data-testid="stdio-edit" className="self-start">
              {t("edit")}
            </Button>
          </li>
        </ul>
        {baseHash === null ? null : <StdioDialog open={editing} onOpenChange={setEditing} granted={stdio} matrix={matrix} baseHash={baseHash} />}
      </CardContent>
    </Card>
  );
}
