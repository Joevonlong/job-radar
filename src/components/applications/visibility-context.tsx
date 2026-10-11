"use client";

import { createContext, useContext, type ReactNode } from "react";

/** The statuses `ui.yaml` hides, for the client components below a page. Display only. */
const HiddenStatusesContext = createContext<readonly string[]>([]);

export function HiddenStatusesProvider({ hidden, children }: { hidden: readonly string[]; children: ReactNode }) {
  return <HiddenStatusesContext.Provider value={hidden}>{children}</HiddenStatusesContext.Provider>;
}

export function useHiddenStatuses(): readonly string[] {
  return useContext(HiddenStatusesContext);
}
