"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition, type FormEvent } from "react";

import { saveStdioPermissionsAction } from "@/app/settings/agents/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { PERMISSION_NOTES, PRESET_IDS, ineffectivePermissions, normalizePermissions, presetOf, presetSelection, type PresetId } from "@/lib/agent-access/matrix";
import type { Permission } from "@/lib/agent-access/permissions";

import { PermissionPill } from "./permission-pill";
import { useReportResult } from "./use-report-result";

/** On a phone the dialog is a full-width sheet at the bottom of the screen. */
export const SHEET_ON_PHONE = "max-h-[90dvh] overflow-y-auto max-sm:top-auto max-sm:bottom-0 max-sm:max-w-full max-sm:translate-y-0 max-sm:rounded-b-none";

interface StdioFormProps {
  granted: Permission[];
  matrix: Permission[];
  baseHash: string;
  onSaved: () => void;
}

/** Lives inside the dialog's content, so closing the dialog drops the unsaved ticks. */
function StdioForm({ granted, matrix, baseHash, onSaved }: StdioFormProps) {
  const t = useTranslations("agents.stdioDialog");
  const tNotes = useTranslations("agents.matrix.notes");
  const tPresets = useTranslations("agents.matrix.presets");
  const report = useReportResult();
  const allowed = new Set(matrix);
  const [selection, setSelection] = useState<Permission[]>(() => normalizePermissions(granted.filter((permission) => allowed.has(permission))));
  const [pending, startTransition] = useTransition();
  const outside = ineffectivePermissions(granted, matrix);
  const chosen = new Set(selection);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    startTransition(async () => {
      if (report(await saveStdioPermissionsAction({ permissions: selection, baseHash }))) onSaved();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {matrix.length === 0 ? (
        <p className="text-body-sm text-ink-2" data-testid="stdio-empty">
          {t("empty")}
        </p>
      ) : (
        <>
          <Segmented aria-label={t("presetsLabel")} value={presetOf(selection, matrix) ?? ""} onValueChange={(id) => setSelection(presetSelection(id as PresetId, matrix))} disabled={pending}>
            {PRESET_IDS.map((id) => (
              <SegmentedItem key={id} value={id}>
                {tPresets(id)}
              </SegmentedItem>
            ))}
          </Segmented>
          <fieldset className="grid grid-cols-1 gap-1 sm:grid-cols-2" data-testid="stdio-permissions">
            <legend className="sr-only">{t("permissions")}</legend>
            {matrix.map((permission) => {
              const note = PERMISSION_NOTES[permission];
              return (
                <label key={permission} className="flex min-h-11 cursor-pointer items-start gap-2 py-1.5">
                  <Checkbox
                    checked={chosen.has(permission)}
                    disabled={pending}
                    onCheckedChange={(value) => setSelection((current) => normalizePermissions(value === true ? [...current, permission] : current.filter((item) => item !== permission)))}
                    data-testid={`stdio-${permission}`}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="font-mono text-data">{permission}</span>
                    {note ? (
                      <Badge variant="gate-note" className="text-left whitespace-normal">
                        {tNotes(note)}
                      </Badge>
                    ) : null}
                  </span>
                </label>
              );
            })}
          </fieldset>
        </>
      )}
      {outside.length > 0 ? (
        <div className="flex flex-col gap-1">
          <p className="text-body-sm text-ink-2">{t("outside")}</p>
          <span className="flex flex-wrap gap-1">
            {outside.map((permission) => (
              <PermissionPill key={permission} permission={permission} effective={false} />
            ))}
          </span>
        </div>
      ) : null}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button">{t("cancel")}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending || matrix.length === 0} data-testid="stdio-save">
          {pending ? t("saving") : t("save")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The local stdio grant: only what the matrix allows can be ticked; what the file already holds beyond it is kept and shown as giving nothing. */
export function StdioDialog({ open, onOpenChange, granted, matrix, baseHash }: { open: boolean; onOpenChange: (open: boolean) => void } & Omit<StdioFormProps, "onSaved">) {
  const t = useTranslations("agents.stdioDialog");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={SHEET_ON_PHONE} data-testid="stdio-dialog">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <StdioForm granted={granted} matrix={matrix} baseHash={baseHash} onSaved={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
