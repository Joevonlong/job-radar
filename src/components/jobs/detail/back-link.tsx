"use client";

import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Whether a previous page of this app is in the history (then "back" restores its filters and scroll). */
function cameFromThisApp(): boolean {
  try {
    return window.history.length > 1 && document.referrer !== "" && new URL(document.referrer).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** "Back to the list": history back when we came from a list, otherwise the plain link target. Escape does the same. */
export function BackLink({ href, label }: { href: string; label: string }) {
  const router = useRouter();

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target;
      if (target instanceof HTMLElement && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)) return;
      if (document.querySelector('[role="dialog"]')) return;
      if (cameFromThisApp()) router.back();
      else router.push(href);
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [href, router]);

  return (
    <Link
      href={href}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
        if (cameFromThisApp()) {
          event.preventDefault();
          router.back();
        }
      }}
      className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex w-fit items-center gap-1.5 rounded-sm py-1 pr-2 pl-1 transition-colors"
      data-testid="back-link"
    >
      <ChevronLeft className="size-4" aria-hidden />
      {label}
    </Link>
  );
}
