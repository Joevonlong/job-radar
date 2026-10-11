"use client";

import { useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { clearPendingLeave, getPendingLeave, hasUnsaved, requestLeave, subscribeUnsaved, unsavedVersion } from "@/lib/shell/unsaved";

/** The in-app destination of a plain left click on a link, or null when the click does not leave the current page. */
export function leavingHref(event: MouseEvent, from: Location): string | null {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if ((anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return null;
  const url = new URL(anchor.href, from.href);
  if (url.origin !== from.origin) return null;
  // the same page (a hash or a query change) keeps the form mounted, so nothing is lost
  if (url.pathname === from.pathname) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/**
 * Warns before unsaved edits are thrown away: the browser's own prompt for reload / close, and a small inline dialog
 * (留下 / 放弃改动) for in-app links and the command palette. Mounted once in the shell.
 */
export function UnsavedGuard() {
  const router = useRouter();
  const t = useTranslations("shell.unsaved");
  useSyncExternalStore(subscribeUnsaved, unsavedVersion, unsavedVersion);
  const pending = getPendingLeave();

  useEffect(() => {
    function onBeforeUnload(event: BeforeUnloadEvent) {
      if (!hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function onClick(event: MouseEvent) {
      if (!hasUnsaved()) return;
      const href = leavingHref(event, window.location);
      if (href === null) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      requestLeave(href);
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    // capture: before Next's <Link> handler sees the click
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, []);

  function discard() {
    if (pending === null) return;
    const href = pending;
    clearPendingLeave();
    router.push(href);
  }

  return (
    <Dialog open={pending !== null} onOpenChange={(open) => (open ? undefined : clearPendingLeave())}>
      <DialogContent showCloseButton={false} data-testid="unsaved-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={clearPendingLeave} data-testid="unsaved-stay">
            {t("stay")}
          </Button>
          <Button type="button" variant="danger" onClick={discard} data-testid="unsaved-discard">
            {t("discard")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
