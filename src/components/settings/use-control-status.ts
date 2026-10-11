"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { STATUS_POLL_MS } from "@/lib/settings/constants";
import { controlStatusSchema, statusNeedsPolling, type ControlStatus } from "@/lib/settings/status-schema";

/** How long after a save or request the page keeps asking, even when nothing looks pending yet. */
const KEEP_POLLING_MS = 15_000;

/**
 * The live status of the runner side (heartbeat, reload acknowledgements, control requests).
 * Polls `/api/control/status` every 2 s while something is pending, and for a short while after
 * `refresh()` is called (a save or a new request has just happened), then stops.
 */
export function useControlStatus(initial: ControlStatus | null): { status: ControlStatus | null; refresh: () => void } {
  const [status, setStatus] = useState<ControlStatus | null>(initial);
  const [grace, setGrace] = useState(false);
  const graceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/control/status", { cache: "no-store" });
      if (!response.ok) return;
      const parsed = controlStatusSchema.safeParse(await response.json());
      if (parsed.success) setStatus(parsed.data);
    } catch {
      // the next poll retries
    }
  }, []);

  const refresh = useCallback(() => {
    setGrace(true);
    if (graceTimer.current) clearTimeout(graceTimer.current);
    graceTimer.current = setTimeout(() => setGrace(false), KEEP_POLLING_MS);
    void load();
  }, [load]);

  useEffect(
    () => () => {
      if (graceTimer.current) clearTimeout(graceTimer.current);
    },
    [],
  );

  const polling = status !== null && (statusNeedsPolling(status) || grace);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  return { status, refresh };
}
