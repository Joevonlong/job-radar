"use server";

import { revalidatePath } from "next/cache";

import { createAgentTokenFromWeb, revokeAgentTokenFromWeb, type CreateAgentTokenResult, type RevokeAgentTokenResult } from "@/lib/agent-access/token-service";
import { saveAgentMatrix, saveStdioPermissions, setAgentSwitch, type AgentSettingsResult } from "@/lib/agent-access/settings-service";
import { requestOwnerSession } from "@/lib/security/owner-session";
import { AGENTS_PAGE } from "@/lib/settings/tabs";

// Server Actions are public POST endpoints. Each request is validated again in the service, and whether it may change anything is
// decided from this request's own cookies and headers, never from its arguments. A new token's secret is only in the return value of
// createAgentTokenAction (Next.js sends Server Action responses with Cache-Control: no-store); the page rendered after it reads the
// database, which holds only the hash and the display prefix.

async function after(result: AgentSettingsResult): Promise<AgentSettingsResult> {
  if (result.status === "saved" || result.status === "stale") revalidatePath(AGENTS_PAGE);
  return result;
}

export async function setAgentSwitchAction(request: unknown): Promise<AgentSettingsResult> {
  return after(await setAgentSwitch(request, await requestOwnerSession()));
}

export async function saveAgentMatrixAction(request: unknown): Promise<AgentSettingsResult> {
  return after(await saveAgentMatrix(request, await requestOwnerSession()));
}

export async function saveStdioPermissionsAction(request: unknown): Promise<AgentSettingsResult> {
  return after(await saveStdioPermissions(request, await requestOwnerSession()));
}

export async function createAgentTokenAction(request: unknown): Promise<CreateAgentTokenResult> {
  const result = await createAgentTokenFromWeb(request, await requestOwnerSession());
  if (result.status === "created") revalidatePath(AGENTS_PAGE);
  return result;
}

export async function revokeAgentTokenAction(request: unknown): Promise<RevokeAgentTokenResult> {
  const result = await revokeAgentTokenFromWeb(request, await requestOwnerSession());
  if (result.status === "revoked" || result.status === "not_found") revalidatePath(AGENTS_PAGE);
  return result;
}
