"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { SOURCES_REFRESH_MS } from "@/lib/settings/constants";

/** Re-renders the server page every few seconds while `active` (a cycle is running); renders nothing. */
export function AutoRefresh({ active, intervalMs = SOURCES_REFRESH_MS }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, router]);
  return null;
}
