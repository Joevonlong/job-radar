import type { AgentAccessView } from "@/lib/agent-access/settings-view";
import { AGENTS_PAGE } from "@/lib/settings/tabs";

import { ConnectionsCard } from "./connections-card";
import { MatrixCard } from "./matrix-card";
import { SessionBanner } from "./session-banner";
import { StatusCard } from "./status-card";

/**
 * The agent access page under its header: the login card when a change needs a session this request does not have, then the
 * status, the global matrix and the connections. Without a session every control is read-only; the server refuses the change anyway.
 */
export function AgentAccessPage({ view, address, now }: { view: AgentAccessView; address: string; now: string }) {
  const locked = view.session === "login_required";
  const config = view.config;
  const baseHash = config.ok ? config.baseHash : null;
  const matrix = config.ok ? config.matrix : [];
  const stdio = config.ok ? config.stdio : [];
  return (
    <div className="flex flex-col gap-4" data-testid="agents-page" data-session={view.session}>
      {locked ? <SessionBanner next={AGENTS_PAGE} /> : null}
      <StatusCard config={config} status={view.status} passwordUsable={view.passwordUsable} locked={locked} address={address} now={now} />
      <MatrixCard key={baseHash ?? "unreadable"} saved={matrix} baseHash={baseHash} locked={locked} tools={view.tools} grants={[stdio, ...(view.tokenGrants ?? [])]} />
      <ConnectionsCard key={`stdio-${baseHash ?? "unreadable"}`} stdio={stdio} matrix={matrix} baseHash={baseHash} locked={locked} />
    </div>
  );
}
