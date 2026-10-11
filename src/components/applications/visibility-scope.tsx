import type { ReactNode } from "react";

import { readHiddenSettings } from "@/lib/applications/hidden";

import { HiddenStatusesProvider } from "./visibility-context";

/** A page's body wrapped so that its client components know which statuses are hidden (read fresh on every request). */
export function VisibilityScope({ children }: { children: ReactNode }) {
  return <HiddenStatusesProvider hidden={readHiddenSettings().statuses}>{children}</HiddenStatusesProvider>;
}
