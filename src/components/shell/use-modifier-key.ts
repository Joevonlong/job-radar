"use client";

import { useSyncExternalStore } from "react";

import { modifierFor, type ModifierLabel } from "@/lib/shell/shortcut";

const noSubscription = () => () => undefined;

function clientModifier(): ModifierLabel {
  if (typeof navigator === "undefined") return "Ctrl";
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return modifierFor(platform || navigator.userAgent);
}

/** The label of the shortcut modifier on this device (⌘ on Apple, Ctrl elsewhere). The server render says Ctrl; the browser corrects it after hydration. */
export function useModifierKey(): ModifierLabel {
  return useSyncExternalStore(noSubscription, clientModifier, () => "Ctrl");
}
