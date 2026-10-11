import type { ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Brand } from "./brand";
import { CycleStatus } from "./cycle-status";
import { NavList } from "./nav-list";
import { SourceLink } from "./source-link";

/** The terminal sidebar: black in both themes, wordmark, nav, and the cycle status at the bottom. */
export function Sidebar({ signOut = null }: { signOut?: ReactNode }) {
  const t = useTranslations("shell");
  return (
    <aside aria-label={t("sidebar")} className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col gap-sp-1 overflow-y-auto border-r-bw border-term-line bg-term-bg p-sp-3 font-mono text-body-sm text-term-dim md:flex">
      <div className="px-sp-2 pb-sp-3">
        <Brand />
      </div>
      <NavList />
      <CycleStatus />
      <SourceLink />
      {signOut}
    </aside>
  );
}
