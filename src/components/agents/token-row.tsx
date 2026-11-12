"use client";

import { Activity, KeyRound } from "lucide-react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Permission } from "@/lib/agent-access/permissions";
import type { AgentTokenRow } from "@/lib/agent-access/settings-view";
import { formatFullTime, formatShortDate, formatRelativeTime } from "@/lib/format/time";
import { resolveLocale } from "@/i18n/locale";
import { AGENTS_PAGE } from "@/lib/settings/tabs";

import { ConnectionRow, Field, PermissionPills } from "./connection-row";

/** The activity page filtered to one connection. */
export function tokenActivityHref(id: number): string {
  return `${AGENTS_PAGE}/activity?connection=${id}`;
}

/**
 * One token: its name, display prefix (never more of the token: the rest exists nowhere), grant, times and state. An active token can
 * be revoked; a revoked or expired one is read-only.
 */
export function TokenRow({ token, allowed, now, timeZone, locked, onRevoke }: { token: AgentTokenRow; allowed: ReadonlySet<Permission>; now: string; timeZone: string; locked: boolean; onRevoke?: () => void }) {
  const t = useTranslations("agents.connections");
  const tTokens = useTranslations("agents.tokens");
  const options = { locale: resolveLocale(useLocale()), timeZone };
  const current = new Date(now);
  const day = (iso: string) => formatShortDate(new Date(iso), current, options);
  const full = (iso: string) => formatFullTime(iso, options);
  const inactive = token.state !== "active";
  return (
    <ConnectionRow
      testId={`token-${token.id}`}
      muted={inactive}
      actions={
        <>
          {inactive ? null : (
            <Button type="button" size="sm" variant="danger" disabled={locked} onClick={onRevoke} data-testid="token-revoke">
              {tTokens("revoke")}
            </Button>
          )}
          <Button asChild size="sm" variant="ghost">
            <Link href={tokenActivityHref(token.id)} data-testid="token-activity">
              <Activity aria-hidden />
              {tTokens("activity")}
            </Link>
          </Button>
        </>
      }
    >
      <Field label={t("columns.name")} wide>
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 font-bold">
          <KeyRound aria-hidden className="size-4 flex-none" />
          <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="token-name">
            {token.name}
          </span>
          {inactive ? (
            <Badge variant="status" data-testid="token-state" data-state={token.state}>
              {tTokens(`state.${token.state}`)}
            </Badge>
          ) : null}
        </span>
      </Field>
      <Field label={t("columns.prefix")}>
        <span className="font-mono text-data text-ink-2" data-testid="token-prefix" title={tTokens("prefixHint")}>
          {token.prefix}…
        </span>
      </Field>
      <Field label={t("columns.permissions")} wide>
        <PermissionPills granted={token.permissions} allowed={allowed} none={t("none")} />
      </Field>
      <Field label={t("columns.created")}>
        <span title={full(token.createdAt)}>{day(token.createdAt)}</span>
      </Field>
      <Field label={t("columns.lastUsed")}>
        {token.lastUsedAt === null ? <span className="text-ink-3">{tTokens("neverUsed")}</span> : <span title={full(token.lastUsedAt)}>{formatRelativeTime(token.lastUsedAt, current, options)}</span>}
      </Field>
      <Field label={t("columns.expires")}>
        {token.state === "revoked" && token.revokedAt !== null ? (
          <span className="text-ink-3" title={full(token.revokedAt)}>
            {tTokens("revokedOn", { date: day(token.revokedAt) })}
          </span>
        ) : token.state === "expired" ? (
          <span className="text-ink-3">{tTokens("state.expired")}</span>
        ) : token.expiresAt === null ? (
          t("noExpiry")
        ) : (
          // stored as the first instant after the last valid day
          <span title={full(token.expiresAt)}>{day(new Date(Date.parse(token.expiresAt) - 1).toISOString())}</span>
        )}
      </Field>
    </ConnectionRow>
  );
}
