"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { SHELL_IDLE_POLL_MS, STATUS_POLL_MS } from "@/lib/settings/constants";
import { shellStatusSchema, type ShellStatus } from "@/lib/shell/status-schema";

/**
 * The sidebar's cycle status. `initial` is what the server read for the first paint (null when it could not).
 * Asks `/api/shell/status` every `STATUS_POLL_MS` while a cycle runs, every `SHELL_IDLE_POLL_MS` otherwise, and once
 * after each navigation; paused while the tab is hidden.
 */
export function useShellStatus(initial: ShellStatus | null): ShellStatus | null {
  const [status, setStatus] = useState<ShellStatus | null>(initial);
  const pathname = usePathname();
  const first = useRef(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (document.hidden) return;
      try {
        const response = await fetch("/api/shell/status", { cache: "no-store" });
        if (!response.ok) return;
        const parsed = shellStatusSchema.safeParse(await response.json());
        if (parsed.success && !cancelled) setStatus(parsed.data);
      } catch {
        // the next poll retries
      }
    }
    // the server already read it for the very first paint
    if (!(first.current && initial !== null)) void load();
    first.current = false;
    const timer = setInterval(() => void load(), status?.state === "running" ? STATUS_POLL_MS : SHELL_IDLE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [initial, pathname, status?.state]);

  return status;
}
