"use client";

import { useSyncExternalStore } from "react";

/** Values of the browser that never change while the page is open: read after hydration (the server renders without them). */
const never = (): (() => void) => () => {};

let zones: readonly string[] | null = null;
function allZones(): readonly string[] {
  if (zones === null) {
    try {
      zones = Intl.supportedValuesOf("timeZone");
    } catch {
      zones = [];
    }
  }
  return zones;
}
const NO_ZONES: readonly string[] = [];

function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The browser's IANA time zone; null during the server render. */
export function useBrowserTimeZone(): string | null {
  return useSyncExternalStore(never, browserZone, () => null);
}

/** Every IANA time zone the browser knows; empty during the server render. */
export function useTimeZones(): readonly string[] {
  return useSyncExternalStore(never, allZones, () => NO_ZONES);
}
