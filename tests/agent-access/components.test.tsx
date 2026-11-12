import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { ConnectionsCard } from "@/components/agents/connections-card";
import { MatrixCard } from "@/components/agents/matrix-card";
import { PermissionPill } from "@/components/agents/permission-pill";
import { StatusCard } from "@/components/agents/status-card";
import type { Permission } from "@/lib/agent-access/permissions";
import { toolsByPermission, type AgentTokenRow } from "@/lib/agent-access/settings-view";

import en from "../../messages/en.json";

const actions = vi.hoisted(() => ({ setAgentSwitchAction: vi.fn(), saveAgentMatrixAction: vi.fn(), saveStdioPermissionsAction: vi.fn(), createAgentTokenAction: vi.fn(), revokeAgentTokenAction: vi.fn() }));
vi.mock("@/app/settings/agents/actions", () => actions);
vi.mock("@/lib/toast", () => ({ toastTone: vi.fn(), toastUndo: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const wrap = (node: ReactNode) => render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{node}</NextIntlClientProvider>);
const TOOLS = toolsByPermission([{ id: "search_jobs", permission: "jobs:read" }, { id: "get_job", permission: "jobs:read" }]);

const CARD = {
  stdio: [] as Permission[],
  matrix: ["jobs:read", "tracking:read"] as Permission[],
  baseHash: "h",
  session: "ok" as const,
  tokens: [] as AgentTokenRow[],
  address: "http://127.0.0.1:3000/api/mcp",
  now: "2026-11-12T12:00:00Z",
  timeZone: "UTC",
  today: "2026-11-12",
};

function tokenRow(overrides: Partial<AgentTokenRow>): AgentTokenRow {
  return {
    id: 1, name: "laptop", prefix: "jrat_AAAAAAAA", permissions: ["jobs:read"], state: "active", createdAt: "2026-11-01T09:00:00Z",
    lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides,
  };
}

describe("PermissionPill", () => {
  it("draws a permission the matrix does not allow as giving nothing, and says why", () => {
    wrap(
      <>
        <PermissionPill permission="jobs:read" effective />
        <PermissionPill permission="config:write" effective={false} />
      </>,
    );
    const [on, off] = screen.getAllByTestId("permission-pill");
    expect(on).toHaveAttribute("data-effective", "true");
    expect(off).toHaveAttribute("data-effective", "false");
    expect(off).toHaveClass("line-through");
    expect(off).toHaveAttribute("title", "Not in the global matrix: no effect");
    expect(off).toHaveTextContent("Not in the global matrix: no effect");
  });

  it("the stdio row marks its grant against the matrix", () => {
    wrap(<ConnectionsCard {...CARD} stdio={["jobs:read", "config:write"]} matrix={["jobs:read"]} />);
    const pills = within(screen.getByTestId("connection-stdio")).getAllByTestId("permission-pill");
    expect(pills.map((pill) => pill.getAttribute("data-effective"))).toEqual(["true", "false"]);
  });
});

describe("MatrixCard", () => {
  const saved: Permission[] = ["jobs:read", "tracking:read"];

  it("a preset only changes the ticks; saving sends them with the fingerprint and says what narrowing takes", async () => {
    actions.saveAgentMatrixAction.mockResolvedValue({ status: "saved", baseHash: "h2" });
    const user = userEvent.setup();
    wrap(<MatrixCard saved={saved} baseHash="h1" locked={false} tools={TOOLS} grants={[["tracking:read"]]} />);
    expect(screen.getByTestId("matrix-tracking:read")).toHaveAttribute("data-state", "checked");
    expect(screen.getByTestId("matrix-tools-jobs:read")).toHaveTextContent("2 tools");
    await user.click(screen.getByTestId("matrix-preset-all"));
    expect(screen.getByTestId("matrix-raw:read")).toHaveAttribute("data-state", "checked");
    expect(actions.saveAgentMatrixAction).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText("Application tracking: read"));
    expect(screen.getByTestId("matrix-tracking:read")).toHaveAttribute("data-state", "unchecked");
    expect(screen.getByTestId("matrix-impact")).toHaveTextContent("After saving, 1 connection loses 1 permission");
    await user.click(screen.getByTestId("matrix-save"));
    expect(actions.saveAgentMatrixAction).toHaveBeenCalledWith({ permissions: expect.not.arrayContaining(["tracking:read"]), baseHash: "h1" });
  });

  it("shows a dash for a cell that does not exist", () => {
    wrap(<MatrixCard saved={saved} baseHash="h1" locked={false} tools={TOOLS} grants={[]} />);
    const jobs = screen.getByTestId("agents-matrix").querySelector('[data-row="jobs"]') as HTMLElement;
    expect(within(jobs).getByText("Not available")).toBeInTheDocument();
  });

  it("is read-only without a session", () => {
    wrap(<MatrixCard saved={saved} baseHash="h1" locked tools={TOOLS} grants={[]} />);
    expect(screen.getByTestId("matrix-jobs:read")).toBeDisabled();
    expect(screen.getByTestId("matrix-save")).toBeDisabled();
  });
});

describe("StatusCard", () => {
  const status = { verdict: "on" as const, activeTokens: 2, lastCallAt: null };
  const config = { ok: true as const, enabled: true, httpEnabled: false, matrix: [], stdio: [], baseHash: "h" };

  it("without a usable web password the HTTP switch is off and says why", () => {
    wrap(<StatusCard config={config} status={status} passwordUsable={false} locked={false} address="http://127.0.0.1:3000/api/mcp" now="2026-11-11T10:00:00Z" />);
    expect(screen.getByTestId("agents-switch-http")).toBeDisabled();
    expect(screen.getByTestId("agents-http-hint")).toHaveTextContent("Needs a web password");
    expect(screen.getByTestId("doc-link-mcpHttp")).toBeInTheDocument();
    expect(screen.getByTestId("agents-switch-enabled")).toBeEnabled();
    expect(screen.getByTestId("agents-active-tokens")).toHaveTextContent("2 active tokens");
  });

  it("with HTTP on shows the address", () => {
    wrap(<StatusCard config={{ ...config, httpEnabled: true }} status={status} passwordUsable locked={false} address="http://127.0.0.1:3000/api/mcp" now="2026-11-11T10:00:00Z" />);
    expect(screen.getByTestId("agents-mcp-address")).toHaveTextContent("http://127.0.0.1:3000/api/mcp");
  });

  it("an unreadable file locks the switches and links to the repair", () => {
    wrap(<StatusCard config={{ ok: false, file: "mcp.yaml", problem: "schema: enabled" }} status={{ ...status, verdict: "config_error" }} passwordUsable locked={false} address="x" now="2026-11-11T10:00:00Z" />);
    expect(screen.getByTestId("agents-switch-enabled")).toBeDisabled();
    expect(screen.getByTestId("repair-link")).toHaveAttribute("href", "/settings?tab=advanced&file=mcp");
  });
});

describe("ConnectionsCard tokens", () => {
  const tokens = [
    tokenRow({ id: 1, name: "laptop", permissions: ["jobs:read", "config:write"], lastUsedAt: "2026-11-12T11:00:00Z", expiresAt: "2027-01-01T00:00:00Z" }),
    tokenRow({ id: 2, name: "old", state: "revoked", revokedAt: "2026-11-05T10:00:00Z" }),
    tokenRow({ id: 3, name: "trial", state: "expired", expiresAt: "2026-11-10T00:00:00Z" }),
  ];

  it("lists active tokens with their grant against the matrix, and folds the revoked and expired ones away, read-only", () => {
    wrap(<ConnectionsCard {...CARD} tokens={tokens} />);
    const row = screen.getByTestId("token-1");
    expect(within(row).getByTestId("token-prefix")).toHaveTextContent("jrat_AAAAAAAA…");
    expect(within(row).getAllByTestId("permission-pill").map((pill) => pill.getAttribute("data-effective"))).toEqual(["true", "false"]);
    expect(row).toHaveTextContent("1 h ago");
    expect(row).toHaveTextContent("Dec 31");
    expect(within(row).getByTestId("token-activity")).toHaveAttribute("href", "/settings/agents/activity?connection=1");
    const folded = screen.getByTestId("tokens-inactive");
    expect(folded).toHaveTextContent("Revoked or expired (2)");
    expect(folded).not.toHaveAttribute("open");
    expect(within(folded).queryByTestId("token-revoke")).toBeNull();
    expect(within(screen.getByTestId("token-2")).getByTestId("token-state")).toHaveAttribute("data-state", "revoked");
  });

  it("without a session or a web password, nothing can be created; without a session nothing can be revoked", () => {
    const { unmount } = wrap(<ConnectionsCard {...CARD} session="login_required" tokens={tokens} />);
    expect(screen.getByTestId("token-create")).toBeDisabled();
    expect(within(screen.getByTestId("token-1")).getByTestId("token-revoke")).toBeDisabled();
    unmount();
    wrap(<ConnectionsCard {...CARD} session="no_password" tokens={tokens} />);
    expect(screen.getByTestId("token-create")).toBeDisabled();
    expect(screen.getByTestId("token-create-no-password")).toBeInTheDocument();
    expect(within(screen.getByTestId("token-1")).getByTestId("token-revoke")).toBeEnabled();
  });

  it("revoking asks first and says it cannot be undone", async () => {
    actions.revokeAgentTokenAction.mockResolvedValueOnce({ status: "revoked" });
    wrap(<ConnectionsCard {...CARD} tokens={tokens} />);
    await userEvent.click(within(screen.getByTestId("token-1")).getByTestId("token-revoke"));
    expect(screen.getByTestId("token-revoke-dialog")).toHaveTextContent("cannot be undone");
    expect(actions.revokeAgentTokenAction).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId("token-revoke-confirm"));
    expect(actions.revokeAgentTokenAction).toHaveBeenCalledWith({ id: 1 });
    expect(screen.queryByTestId("token-revoke-dialog")).toBeNull();
  });

  it("creates with the read-only preset limited to the matrix, shows the token once, and forgets it when closed", async () => {
    const secret = `jrat_${"Q".repeat(43)}`;
    actions.createAgentTokenAction.mockResolvedValueOnce({ status: "created", secret, token: { id: 9, name: "phone", prefix: secret.slice(0, 13) } });
    wrap(<ConnectionsCard {...CARD} matrix={["jobs:read", "raw:read", "config:write"]} />);
    await userEvent.click(screen.getByTestId("token-create"));
    expect(screen.queryByTestId("token-permission-tracking:read")).toBeNull();
    expect(screen.getByTestId("token-permission-jobs:read")).toHaveAttribute("data-state", "checked");
    expect(screen.getByTestId("token-permission-raw:read")).toHaveAttribute("data-state", "unchecked");
    await userEvent.type(screen.getByTestId("token-name-input"), "phone");
    await userEvent.click(screen.getByTestId("token-create-submit"));
    expect(actions.createAgentTokenAction).toHaveBeenCalledWith({ name: "phone", permissions: ["jobs:read"], expires: null });
    expect(screen.getByTestId("token-secret")).toHaveValue(secret);
    expect(screen.getByTestId("token-address")).toHaveTextContent("http://127.0.0.1:3000/api/mcp");
    expect(screen.getByTestId("token-example")).not.toHaveTextContent(secret);
    await userEvent.click(screen.getByTestId("token-secret-done"));
    expect(screen.queryByTestId("token-secret")).toBeNull();
    expect(document.body.innerHTML).not.toContain(secret);
    await userEvent.click(screen.getByTestId("token-create"));
    expect(screen.getByTestId("token-create-form")).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain(secret);
  });

  it("shows the server's reason when creating is refused", async () => {
    actions.createAgentTokenAction.mockResolvedValueOnce({ status: "name_taken" });
    wrap(<ConnectionsCard {...CARD} />);
    await userEvent.click(screen.getByTestId("token-create"));
    await userEvent.type(screen.getByTestId("token-name-input"), "laptop");
    await userEvent.click(screen.getByTestId("token-create-submit"));
    expect(screen.getByTestId("token-create-error")).toHaveAttribute("data-error", "name_taken");
    expect(screen.queryByTestId("token-secret")).toBeNull();
  });
});
