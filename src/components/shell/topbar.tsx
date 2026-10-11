import type { ReactNode } from "react";

import { Brand } from "./brand";
import { CommandPalette } from "./command-palette";
import { CycleStatusDot } from "./cycle-status";
import { LanguageToggle } from "./language-toggle";
import { MobileNav } from "./mobile-nav";
import { ThemeToggle } from "./theme-toggle";

/** Ghost buttons on the phone's black bar need light text (the default is ink on transparent). */
const TERMINAL_BAR_BUTTON = "max-md:text-term-ink max-md:hover:border-term-line max-md:hover:bg-term-line";

/**
 * Desktop: a paper bar with search, theme and language. Phone (below `md`): the same controls on the terminal bar, the
 * wordmark on the left and ☰ (the drawer) on the right. `minimal` (the setup wizard): the wordmark, theme and
 * language only, on every width (no sidebar, search, cycle status or drawer). `locked` (the login page of the optional web
 * password): the wordmark and theme only. `signOut`: the sign-out button for the drawer.
 */
export function Topbar({ minimal = false, locked = false, signOut = null }: { minimal?: boolean; locked?: boolean; signOut?: ReactNode }) {
  return (
    <header
      data-testid="topbar"
      data-minimal={minimal || undefined}
      className="sticky top-0 z-sticky flex h-14 items-center gap-sp-2 border-b-bw border-border bg-background/80 px-sp-4 backdrop-blur max-md:px-sp-3 max-md:border-term-line max-md:bg-term-bg max-md:font-mono max-md:text-term-ink"
    >
      <Brand className={minimal ? "max-md:text-term-amber md:text-ink" : "md:hidden"} prefetch={locked ? false : undefined} />
      {minimal ? null : <CycleStatusDot className="md:hidden" />}
      <div className="ml-auto flex items-center gap-sp-1">
        {minimal ? null : <CommandPalette />}
        <ThemeToggle className={TERMINAL_BAR_BUTTON} />
        {/* the language switch is a Server Action: not available before the login (the page follows the browser's language) */}
        {locked ? null : <LanguageToggle className={TERMINAL_BAR_BUTTON} />}
        {minimal ? null : <MobileNav signOut={signOut} />}
      </div>
    </header>
  );
}
