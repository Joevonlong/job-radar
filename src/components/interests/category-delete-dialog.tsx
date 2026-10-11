"use client";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { CategorySignalCount } from "@/lib/db/queries/signal-categories";

interface CategoryDeleteDialogProps {
  /** The category asked about; null = closed. */
  target: { id: string; name: string; isNew: boolean } | null;
  /** Stored signals and jobs per category id; null when the database could not be read. */
  counts: Readonly<Record<string, CategorySignalCount>> | null;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * "Delete category X?". A saved category is not erased: it moves to the deleted categories with its definition,
 * and its stored signals stay in the database, hidden; the dialog says how many. An unsaved one simply goes.
 */
export function CategoryDeleteDialog({ target, counts, onCancel, onConfirm }: CategoryDeleteDialogProps) {
  const t = useTranslations("interests.categories");
  const count = target && counts ? (counts[target.id] ?? { signals: 0, jobs: 0 }) : null;
  const body = target === null ? "" : target.isNew ? t("deleteNew") : count === null ? t("deleteUnknownCount") : t("deleteBody", { signals: count.signals, jobs: count.jobs });
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-[460px]" data-testid="category-delete-dialog">
        <DialogHeader>
          <DialogTitle>{t("deleteTitle", { name: target?.name ?? "" })}</DialogTitle>
          <DialogDescription data-testid="category-delete-body" data-signals={count?.signals ?? ""} data-jobs={count?.jobs ?? ""}>
            {body}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="default" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="danger" onClick={onConfirm} data-testid="category-delete-confirm">
            {t("deleteConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
