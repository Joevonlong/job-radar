"use client";

import { Copy } from "lucide-react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { useId, useOptimistic, useRef, useTransition } from "react";

import { setAgentSwitchAction } from "@/app/settings/agents/actions";
import { LoadError } from "@/components/settings/load-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { DocLink } from "@/components/ui/doc-link";
import { Switch } from "@/components/ui/switch";
import type { AgentAccessConfig, AgentAccessStatus } from "@/lib/agent-access/settings-view";
import type { McpVerdict } from "@/lib/ops/doctor/mcp-verdict";
import { AGENTS_ACTIVITY_PAGE } from "@/lib/settings/tabs";
import { toastTone } from "@/lib/toast";

import { useReportResult } from "./use-report-result";

type SwitchKey = "enabled" | "http";

const VERDICT_BADGE: Record<McpVerdict, "status-good" | "status" | "status-warn" | "gate-bad"> = {
  on: "status-good",
  off: "status",
  password_required: "status-warn",
  config_error: "gate-bad",
};

/** The address an HTTP client uses, with a copy button; when the clipboard is not available the text is selected instead. */
function McpAddress({ address }: { address: string }) {
  const t = useTranslations("agents.status.http");
  const ref = useRef<HTMLElement>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      toastTone("success", t("copied"));
    } catch {
      const node = ref.current;
      const selection = window.getSelection();
      if (node && selection) selection.selectAllChildren(node);
      toastTone("info", t("copyFailed"));
    }
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="text-label font-bold text-ink-2">{t("address")}</span>
      <code ref={ref} className="min-w-0 rounded-tag border-bw border-border bg-soft px-2 py-0.5 font-mono text-data [overflow-wrap:anywhere]" data-testid="agents-mcp-address">
        {address}
      </code>
      <Button type="button" size="sm" variant="ghost" onClick={() => void copy()} aria-label={t("copy")}>
        <Copy aria-hidden />
        {t("copy")}
      </Button>
    </div>
  );
}

/**
 * Whether agents can connect at all: the verdict the doctor reports, the master switch and the HTTP switch (both saved at once), the
 * HTTP address while HTTP is on, and how many tokens are active and when an agent last called. Without a session (when one is
 * needed) or with an unreadable mcp.yaml the switches are read-only.
 */
export function StatusCard({ config, status, passwordUsable, locked, address, now }: { config: AgentAccessConfig; status: AgentAccessStatus; passwordUsable: boolean; locked: boolean; address: string; now: string }) {
  const t = useTranslations("agents.status");
  const format = useFormatter();
  const report = useReportResult();
  const id = useId();
  const [pending, startTransition] = useTransition();
  const saved = { enabled: config.ok && config.enabled, http: config.ok && config.httpEnabled };
  const [shown, show] = useOptimistic(saved, (state, patch: Partial<Record<SwitchKey, boolean>>) => ({ ...state, ...patch }));
  const disabled = locked || !config.ok || pending;

  function toggle(key: SwitchKey, value: boolean) {
    startTransition(async () => {
      show({ [key]: value });
      report(await setAgentSwitchAction({ key, value }));
    });
  }

  const lastCall = status.lastCallAt === null ? t("lastCallNever") : t("lastCall", { time: format.relativeTime(new Date(status.lastCallAt), new Date(now)) });
  return (
    <Card data-testid="agents-status-card">
      <CardHeader>
        <CardTitle>
          <h2>{t("title")}</h2>
        </CardTitle>
        <CardAction>
          <Badge variant={VERDICT_BADGE[status.verdict]} data-testid="agents-verdict" data-verdict={status.verdict}>
            {t(`verdict.${status.verdict}`)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="gap-4">
        {config.ok ? null : <LoadError file={config.file} repair={config.file} message={config.problem} />}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={`${id}-enabled`} className="text-body font-bold">
              {t("enabled.label")}
            </label>
            <p className="text-body-sm text-ink-2">{shown.enabled ? t("enabled.hint") : t("enabled.off")}</p>
          </div>
          <Switch id={`${id}-enabled`} checked={shown.enabled} disabled={disabled} onCheckedChange={(value) => toggle("enabled", value)} data-testid="agents-switch-enabled" className="disabled:border-dotted" />
        </div>
        <div className="flex flex-col gap-2 border-t-[1.5px] border-grid pt-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={`${id}-http`} className="text-body font-bold">
                {t("http.label")}
              </label>
              <p className="text-body-sm text-ink-2" data-testid="agents-http-hint">
                {passwordUsable ? t("http.hint") : t.rich("http.noPassword", { doc: (chunks) => <DocLink doc="mcpHttp">{chunks}</DocLink> })}
              </p>
            </div>
            <Switch
              id={`${id}-http`}
              checked={shown.http}
              disabled={disabled || (!passwordUsable && !shown.http)}
              onCheckedChange={(value) => toggle("http", value)}
              data-testid="agents-switch-http"
              className="disabled:border-dotted"
            />
          </div>
          {shown.http ? <McpAddress address={address} /> : null}
        </div>
      </CardContent>
      <CardFooter className="flex-wrap gap-x-4 gap-y-1 font-mono text-data text-ink-2">
        <span data-testid="agents-active-tokens">{status.activeTokens === null ? t("tokensUnknown") : t("tokens", { count: status.activeTokens })}</span>
        <span data-testid="agents-last-call">
          {status.lastCallAt === null ? (
            lastCall
          ) : (
            <Link href={AGENTS_ACTIVITY_PAGE} className="underline decoration-dotted underline-offset-4">
              {lastCall}
            </Link>
          )}
        </span>
      </CardFooter>
    </Card>
  );
}
