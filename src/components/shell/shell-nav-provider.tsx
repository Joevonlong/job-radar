"use client";

import { createContext, useContext, type ReactNode } from "react";

import { navItems, type NavItem } from "./nav";

/** Whether the optional career item is in the navigation, read by the server shell on every render. */
const ShellNavContext = createContext(false);

export function ShellNavProvider({ career, children }: { career: boolean; children: ReactNode }) {
  return <ShellNavContext.Provider value={career}>{children}</ShellNavContext.Provider>;
}

/** The nav items for the sidebar, the drawer and the command palette; the default items outside a provider. */
export function useNavItems(): readonly NavItem[] {
  return navItems(useContext(ShellNavContext));
}
