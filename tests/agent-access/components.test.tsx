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
import { toolsByPermission } from "@/lib/agent-access/settings-view";

import en from "../../messages/en.json";

const actions = vi.hoisted(() => ({ setAgentSwitchAction: vi.fn(), saveAgentMatrixAction: vi.fn(), saveStdioPermissionsAction: vi.fn() }));
vi.mock("@/app/settings/agents/actions", () => actions);
vi.mock("@/lib/toast", () => ({ toastTone: vi.fn(), toastUndo: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const wrap = (node: ReactNode) => render(<NextIntlClientProvider locale="en" messages={en} timeZone="UTC">{node}</NextIntlClientProvider>);
const TOOLS = toolsByPermission([{ id: "search_jobs", permission: "jobs:read" }, { id: "get_job", permission: "jobs:read" }]);

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
    wrap(<ConnectionsCard stdio={["jobs:read", "config:write"]} matrix={["jobs:read"]} baseHash="h" locked={false} />);
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
