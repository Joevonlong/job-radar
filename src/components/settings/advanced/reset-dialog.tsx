"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffYaml } from "@/lib/config/diff";

import { DiffView } from "./diff-view";

interface ResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The user's file (masked): all of it goes. */
  current: string;
  pending: boolean;
  onConfirm: () => void;
}

/** "Restore default": says what happens, shows the user's text that goes, and asks once. The old text is backed up first. */
export function ResetDialog({ open, onOpenChange, current, pending, onConfirm }: ResetDialogProps) {
  const t = useTranslations("settings.advanced.reset");
  const lines = diffYaml(current, "", 3);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="reset-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {lines.length === 0 ? <p className="text-ink-2 font-bold">{t("noChanges")}</p> : <DiffView lines={lines} />}
        <DialogFooter>
          <Button type="button" variant="default" onClick={() => onOpenChange(false)}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="danger" disabled={pending} data-testid="reset-confirm" onClick={onConfirm}>
            {pending ? t("working") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
