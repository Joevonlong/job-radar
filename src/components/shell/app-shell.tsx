import type { ReactNode } from "react";

import { getDb } from "@/lib/db";
import { loadShellStatus } from "@/lib/shell/status";
import type { ShellStatus } from "@/lib/shell/status-schema";

import { AccessBanner } from "./access-banner";
import { ScrollProgress } from "./scroll-progress";
import { ShellChrome } from "./shell-chrome";
import { ShellStatusProvider } from "./shell-status-provider";
import { Sidebar } from "./sidebar";
import { MAIN_CONTENT_ID } from "./main-content-id";
import { SkipLink } from "./skip-link";
import { SignOutButton } from "./sign-out-button";
import { Topbar } from "./topbar";
import { UnsavedGuard } from "./unsaved-guard";

/** What the server could read for the first paint of the cycle status; null (database down, config broken) lets the client ask. */
async function readInitialStatus(): Promise<ShellStatus | null> {
  try {
    return await loadShellStatus(getDb());
  } catch {
    return null;
  }
}

/** What the optional web password means for this request (computed by the root layout from the request). */
export interface ShellAccess {
  /** A password is set and this visitor has no session: only the login page is reachable, so the shell shows nothing else. */
  locked: boolean;
  /** No password, and the dashboard is reached from elsewhere: the warning banner. */
  banner: boolean;
  /** Signed in with the password: the sign-out button. */
  signOut: boolean;
}

export async function AppShell({ children, access }: { children: ReactNode; access: ShellAccess }) {
  if (access.locked) {
    // The login page: no cycle status, navigation or search (they would read the database for a visitor without access).
    return (
      <div className="flex min-h-screen flex-col">
        <SkipLink />
        <Topbar minimal locked />
        <main id={MAIN_CONTENT_ID} tabIndex={-1} className="focus:outline-none mx-auto w-full max-w-6xl flex-1 p-sp-4 md:p-sp-8">{children}</main>
      </div>
    );
  }
  const initialStatus = await readInitialStatus();
  const signOut = access.signOut ? <SignOutButton /> : null;
  return (
    <ShellStatusProvider initial={initialStatus}>
      <SkipLink />
      {access.banner ? <AccessBanner /> : null}
      <div className="flex min-h-screen">
        <ScrollProgress />
        <UnsavedGuard />
        <ShellChrome sidebar={<Sidebar signOut={signOut} />} topbar={<Topbar signOut={signOut} />} setupTopbar={<Topbar minimal />}>
          {children}
        </ShellChrome>
      </div>
    </ShellStatusProvider>
  );
}
