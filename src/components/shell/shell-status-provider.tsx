"use client";

import { createContext, useContext, type ReactNode } from "react";

import type { ShellStatus } from "@/lib/shell/status-schema";

import { useShellStatus } from "./use-shell-status";

/** The polled shell status, kept in one place so the sidebar, the drawer, the phone top bar and the nav badges share one poll. */
const ShellStatusContext = createContext<{ status: ShellStatus | null } | null>(null);

export function ShellStatusProvider({ initial, children }: { initial: ShellStatus | null; children: ReactNode }) {
  const status = useShellStatus(initial);
  return <ShellStatusContext.Provider value={{ status }}>{children}</ShellStatusContext.Provider>;
}

/** The shared status; `undefined` outside a provider (tests, pages without the shell). */
export function useSharedShellStatus(): ShellStatus | null | undefined {
  return useContext(ShellStatusContext)?.status;
}

/** Which of the faces the cycle status shows; offline wins over everything the runner would do itself. */
export type ShellHealth = "offline" | "aiOffline" | "ok";

/** Pure: the runner (or, while the AI part runs, the ai-worker) is not answering. `null` status = not read yet. */
export function shellHealth(status: ShellStatus | null): ShellHealth {
  if (status === null) return "ok";
  const aiPhase = status.state === "running" && status.progress?.phase === "ai";
  // the AI phase belongs to the ai-worker, everything else to the runner
  if (!status.runner.online && !(aiPhase && status.aiWorker.online)) return "offline";
  if (status.aiWorker.expected && !status.aiWorker.online) return "aiOffline";
  return "ok";
}
