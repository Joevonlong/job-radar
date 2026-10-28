"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import { previewAdvancedAction as rawPreviewAdvancedAction } from "@/app/settings/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { AdvancedLayer, AdvancedPreview, AdvancedPreviewAgainst } from "@/lib/settings/advanced/types";

import { ChangedPaths, DiffView } from "./diff-view";
import { OverrideWarning } from "./override-warning";
import { withActionFeedback } from "@/lib/actions/client";

const previewAdvancedAction = withActionFeedback(rawPreviewAdvancedAction)(() => (null));

interface PreviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stem: string;
  text: string;
  /** The file is a product default that has no user copy yet: saving creates an override of the whole file (needs a second confirmation). */
  firstOverride: boolean;
  hasDefault: boolean;
  saving: boolean;
  /** Saving is blocked (the text has problems). */
  blocked: boolean;
  onConfirm: (confirmOverride: boolean) => void;
  /** The hash and layer the editor opened the file with: the preview says when the file changed since. */
  baseHash: string;
  baseLayer: AdvancedLayer;
  /** The file changed behind the editor's back: the dialog closes and the conflict banner takes over. */
  onStale: (current: { text: string; hash: string; layer: AdvancedLayer }) => void;
}

/** "Preview and save": the diff against what is saved (or against the product default), the changed key paths, and the save button. */
export function PreviewDialog({ open, onOpenChange, ...body }: PreviewDialogProps) {
  const t = useTranslations("settings.advanced.preview");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="preview-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {/* mounted per opening: a fresh diff and an unticked confirmation every time */}
        <PreviewBody {...body} onCancel={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ stem, text, firstOverride, hasDefault, saving, blocked, onConfirm, baseHash, baseLayer, onStale, onCancel }: Omit<PreviewDialogProps, "open" | "onOpenChange"> & { onCancel: () => void }) {
  const t = useTranslations("settings.advanced.preview");
  const [against, setAgainst] = useState<AdvancedPreviewAgainst>("saved");
  const [preview, setPreview] = useState<AdvancedPreview | null>(null);
  const [failed, setFailed] = useState(false);
  const [understood, setUnderstood] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void previewAdvancedAction({ file: stem, text, against, baseHash, baseLayer }).then((result) => {
      if (cancelled) return;
      if (result === null) setFailed(true);
      else if (result.stale !== null) onStale(result.stale);
      else setPreview(result);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onStale is a fresh closure on every render; the request must not repeat for it
  }, [stem, text, against, baseHash, baseLayer]);

  const pick = (option: AdvancedPreviewAgainst) => {
    setPreview(null);
    setFailed(false);
    setAgainst(option);
  };
  const needsUnderstanding = firstOverride && !understood;
  return (
    <>
      {hasDefault ? (
        <div role="group" aria-label={t("against")} className="flex flex-wrap gap-2">
          {(["saved", "default"] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={against === option}
              data-testid={`preview-against-${option}`}
              onClick={() => pick(option)}
              className="border-border bg-card aria-pressed:bg-hi aria-pressed:text-hi-ink hover:bg-soft rounded-tag border-bw px-3 py-1 text-label font-bold"
            >
              {t(`against_${option}`)}
            </button>
          ))}
        </div>
      ) : null}
      {failed ? (
        <p role="alert" className="text-bad font-bold">
          {t("failed")}
        </p>
      ) : preview === null ? (
        <p className="text-ink-2" role="status">
          {t("loading")}
        </p>
      ) : !preview.changed ? (
        <p className="text-ink-2 font-bold" role="status" data-testid="preview-no-changes">
          {t("noChanges")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          <ChangedPaths paths={preview.paths} />
          <DiffView lines={preview.lines} />
        </div>
      )}
      {firstOverride ? <OverrideWarning confirm={{ checked: understood, onChange: setUnderstood }} /> : null}
      <DialogFooter>
        <Button type="button" variant="default" onClick={onCancel}>
          {t("cancel")}
        </Button>
        <Button type="button" variant="primary" disabled={saving || blocked || needsUnderstanding} data-testid="preview-confirm" onClick={() => onConfirm(firstOverride && understood)}>
          {saving ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </>
  );
}
