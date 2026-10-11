"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";

import { Brand } from "./brand";
import { CycleStatus } from "./cycle-status";
import { NavList } from "./nav-list";

/** Terminal-coloured ghost button for the black bar and drawer (the default ghost is ink on transparent: invisible on black). */
const TERMINAL_BUTTON = "text-term-ink hover:border-term-line hover:bg-term-line";

/** The ☰ button of the phone top bar and the drawer it opens (the sidebar's content, terminal black in both themes). */
export function MobileNav({ signOut = null }: { signOut?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const t = useTranslations("shell");

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className={`md:hidden ${TERMINAL_BUTTON}`} aria-label={t("openMenu")}>
          <span aria-hidden>☰</span>
        </Button>
      </SheetTrigger>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-64 gap-0 border-term-line bg-term-bg p-0 font-mono text-term-ink"
      >
        <SheetHeader className="flex-row items-center justify-between px-sp-4 pt-sp-4 pb-sp-3">
          <SheetTitle className="sr-only">{t("menuTitle")}</SheetTitle>
          <SheetDescription className="sr-only">{t("menuDescription")}</SheetDescription>
          <Brand />
          <SheetClose asChild>
            <Button variant="ghost" size="icon-sm" className={TERMINAL_BUTTON} aria-label={t("close")}>
              <span aria-hidden>✕</span>
            </Button>
          </SheetClose>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-sp-3 overflow-y-auto px-sp-3 pb-sp-3">
          <NavList onNavigate={() => setOpen(false)} />
          <CycleStatus />
          {signOut}
        </div>
      </SheetContent>
    </Sheet>
  );
}
