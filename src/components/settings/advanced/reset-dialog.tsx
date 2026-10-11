"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { diffYaml } from "@/lib/config/diff";

import { DiffView } from "./diff-view";

interface ResetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The shipped default (a product default file: the override is removed; a user file: its text replaces the file). */
  shipped: boolean;
  /** What is saved now and the default (both masked): the dialog shows what would change. */
  current: string;
  defaultText: string;
  pending: boolean;
  onConfirm: () => void;
}

/** "Restore default": says what happens, shows the diff from the saved text to the default, and asks once. The old text is backed up first. */
export function ResetDialog({ open, onOpenChange, shipped, current, defaultText, pending, onConfirm }: ResetDialogProps) {
  const t = useTranslations("settings.advanced.reset");
  const lines = diffYaml(current, defaultText, 3);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="reset-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t(shipped ? "descriptionShipped" : "descriptionUser")}</DialogDescription>
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
