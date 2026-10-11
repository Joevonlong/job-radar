"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { setSourceEnabledAction } from "@/app/sources/registry/actions";
import { Button } from "@/components/ui/button";
import { DocLink } from "@/components/ui/doc-link";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import type { ConsentKind } from "@/lib/channels/access";
import { toastTone } from "@/lib/toast";

/**
 * The on/off switch of a channel or a board. It flips at once and writes `enabled` of the entry into sources.yaml;
 * when the write is refused it flips back and says why. Read-only (legacy or unreadable file) or locked (it depends on another
 * channel that is off): disabled with a hint, so it never claims a change it did not write.
 */
export function EnabledSwitch({ id, name, enabled, readOnlyHint, lockedHint = null, consent = null }: { id: string; name: string; enabled: boolean; readOnlyHint: string | null; lockedHint?: string | null; consent?: ConsentKind | null }) {
  const t = useTranslations("sourcesRegistry");
  const [synced, setSynced] = useState(enabled);
  const [optimistic, setOptimistic] = useState<boolean | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState(false);
  // the server value wins again as soon as a new page arrives
  if (synced !== enabled) {
    setSynced(enabled);
    setOptimistic(null);
  }
  const checked = optimistic ?? enabled;

  const apply = (next: boolean, acknowledged = false) => {
    setOptimistic(next);
    startTransition(async () => {
      const result = await setSourceEnabledAction({ id, enabled: next, ...(acknowledged ? { acknowledged: true } : {}) });
      if (result.status === "error") {
        setOptimistic(null);
        toastTone("error", t(`errors.${result.error}`));
        return;
      }
      toastTone("success", t(next ? "toast.enabled" : "toast.disabled", { name }));
    });
  };

  const change = (next: boolean) => {
    // a scraping channel whose site restricts automated access: switching it on needs the notice acknowledged first
    if (next && consent !== null) setConfirming(true);
    else apply(next);
  };

  return (
    <span title={readOnlyHint ?? lockedHint ?? undefined} className="inline-flex">
      <Switch
        checked={checked}
        disabled={readOnlyHint !== null || lockedHint !== null || pending}
        onCheckedChange={change}
        aria-label={t("row.switchLabel", { name })}
        data-testid="enabled-switch"
        data-id={id}
      />
      {confirming && consent !== null ? (
        <Dialog open onOpenChange={(open) => setConfirming(open)}>
          <DialogContent data-testid="consent-dialog">
            <DialogHeader>
              <DialogTitle>{t("consent.title", { name })}</DialogTitle>
              <DialogDescription>{t(`consent.${consent}`)}</DialogDescription>
            </DialogHeader>
            <p className="text-body-sm text-ink-2">{t.rich("consent.responsibility", { docs: (chunks) => <DocLink doc="scraping">{chunks}</DocLink> })}</p>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setConfirming(false)} data-testid="consent-cancel">
                {t("consent.cancel")}
              </Button>
              <Button
                type="button"
                onClick={() => {
                  setConfirming(false);
                  apply(true, true);
                }}
                data-testid="consent-confirm"
              >
                {t("consent.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </span>
  );
}
