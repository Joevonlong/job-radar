"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { MAIN_CONTENT_ID } from "./main-content-id";

/** The setup wizard (`/setup`) runs without the sidebar, search and drawer; the rest of the app keeps them. */
export function isSetupPath(pathname: string | null): boolean {
  return pathname === "/setup" || (pathname?.startsWith("/setup/") ?? false);
}

interface ShellChromeProps {
  sidebar: ReactNode;
  topbar: ReactNode;
  /** The reduced top bar of the wizard (wordmark, theme, language). */
  setupTopbar: ReactNode;
  children: ReactNode;
}

export function ShellChrome({ sidebar, topbar, setupTopbar, children }: ShellChromeProps) {
  const setup = isSetupPath(usePathname());
  return (
    <>
      {setup ? null : sidebar}
      <div className="flex min-w-0 flex-1 flex-col [&:has([data-fit-viewport])]:min-h-0 [&:has([data-fit-viewport])>header]:shrink-0">
        {setup ? setupTopbar : topbar}
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="focus:outline-none mx-auto w-full max-w-6xl flex-1 p-sp-4 md:p-sp-8 [&:has([data-wide])]:max-w-none [&:has([data-fit-viewport])]:flex [&:has([data-fit-viewport])]:min-h-0 [&:has([data-fit-viewport])]:flex-col [&:has([data-fit-viewport])]:overflow-y-auto">{children}</main>
      </div>
    </>
  );
}
