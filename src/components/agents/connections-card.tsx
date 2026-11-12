"use client";

import { ChevronRight, Plus, Terminal } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DocLink } from "@/components/ui/doc-link";
import type { Permission } from "@/lib/agent-access/permissions";
import type { AgentTokenRow as TokenRowData } from "@/lib/agent-access/settings-view";
import type { OwnerSessionState } from "@/lib/security/owner-session";

import { ConnectionRow, Field, PermissionPills } from "./connection-row";
import { StdioDialog } from "./stdio-dialog";
import { TokenCreateDialog } from "./token-create-dialog";
import { TokenRevokeDialog } from "./token-revoke-dialog";
import { TokenRow } from "./token-row";

interface ConnectionsCardProps {
  stdio: Permission[];
  matrix: Permission[];
  baseHash: string | null;
  session: OwnerSessionState;
  /** Null when the database cannot be read. */
  tokens: TokenRowData[] | null;
  address: string;
  now: string;
  timeZone: string;
  today: string;
}

/**
 * Everything that can connect: first the local stdio process (it has no token; its grant lives in mcp.yaml), then the tokens that can
 * still be used, and the revoked and expired ones folded away, read-only. Each row shows its grant, with what the matrix does not allow
 * drawn as giving nothing. A new token is shown once, in the dialog that created it.
 */
export function ConnectionsCard({ stdio, matrix, baseHash, session, tokens, address, now, timeZone, today }: ConnectionsCardProps) {
  const t = useTranslations("agents.connections");
  const tTokens = useTranslations("agents.tokens");
  const [editing, setEditing] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<TokenRowData | null>(null);
  const locked = session === "login_required";
  const allowed = new Set(matrix);
  const active = tokens?.filter((token) => token.state === "active") ?? [];
  const inactive = tokens?.filter((token) => token.state !== "active") ?? [];
  return (
    <Card data-testid="agents-connections-card">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardDescription>{t("description")}</CardDescription>
        <CardAction>
          <Button type="button" variant="primary" size="sm" disabled={session !== "ok" || baseHash === null} onClick={() => setCreating(true)} data-testid="token-create">
            <Plus aria-hidden />
            {tTokens("create")}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {session === "no_password" ? (
          <p className="text-body-sm text-ink-2" data-testid="token-create-no-password">
            {tTokens.rich("noPassword", { doc: (chunks) => <DocLink doc="mcpHttp">{chunks}</DocLink> })}
          </p>
        ) : null}
        <ul className="flex flex-col gap-3">
          <ConnectionRow
            testId="connection-stdio"
            actions={
              <Button type="button" size="sm" disabled={locked || baseHash === null} onClick={() => setEditing(true)} data-testid="stdio-edit">
                {t("edit")}
              </Button>
            }
          >
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
              <PermissionPills granted={stdio} allowed={allowed} none={t("none")} />
            </Field>
            <Field label={t("columns.created")}>
              <span className="font-mono text-ink-3">—</span>
            </Field>
            <Field label={t("columns.lastUsed")}>
              <span className="font-mono text-ink-3">—</span>
            </Field>
            <Field label={t("columns.expires")}>{t("noExpiry")}</Field>
          </ConnectionRow>
          {active.map((token) => (
            <TokenRow key={token.id} token={token} allowed={allowed} now={now} timeZone={timeZone} locked={locked} onRevoke={() => setRevoking(token)} />
          ))}
        </ul>
        {tokens === null ? (
          <p className="text-body-sm text-ink-2" role="status" data-testid="tokens-unreadable">
            {tTokens("unreadable")}
          </p>
        ) : active.length === 0 ? (
          <p className="text-body-sm text-ink-2" data-testid="tokens-empty">
            {tTokens("empty")}
          </p>
        ) : null}
        {inactive.length > 0 ? (
          <details className="group flex flex-col gap-3" data-testid="tokens-inactive">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 text-body-sm font-bold text-ink-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="size-4 transition-transform duration-fast group-open:rotate-90 motion-reduce:transition-none" />
              {tTokens("inactive", { count: inactive.length })}
            </summary>
            <ul className="mt-3 flex flex-col gap-3">
              {inactive.map((token) => (
                <TokenRow key={token.id} token={token} allowed={allowed} now={now} timeZone={timeZone} locked />
              ))}
            </ul>
          </details>
        ) : null}
        {baseHash === null ? null : <StdioDialog open={editing} onOpenChange={setEditing} granted={stdio} matrix={matrix} baseHash={baseHash} />}
        <TokenCreateDialog open={creating} onOpenChange={setCreating} matrix={matrix} address={address} today={today} />
        <TokenRevokeDialog token={revoking} onClose={() => setRevoking(null)} />
      </CardContent>
    </Card>
  );
}
