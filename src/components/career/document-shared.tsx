"use client";

import { useTranslations } from "next-intl";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

export const documentReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

export function DocumentStatus({ code }: { code: string }) {
  const t = useTranslations("career.documents");
  if (!code) return null;
  const known = [
    "saved",
    "stale",
    "saving",
    "unsaved",
    "history_failed",
    "profile_unreadable",
    "profile_empty",
    "too_large",
    "bad_type",
    "document_invalid",
    "document_missing",
    "document_limit",
    "preferences_invalid",
    "image_invalid",
    "write_failed",
    "disabled",
  ] as const;
  const key = known.find((key) => key === code) ?? "generic";
  return (
    <p
      role={key === "saved" || key === "saving" || key === "unsaved" ? "status" : "alert"}
      data-code={key}
      className="break-words text-body-sm"
    >
      {t(`status.${key}`)}
    </p>
  );
}

export function DocumentConfirm({
  open,
  title,
  pending,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  pending: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const t = useTranslations("career.documents");
  return (
    <Dialog
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{t("confirmDescription")}</DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DocumentInput({
  label,
  value,
  onChange,
  multiline = false,
  type = "text",
}: {
  label: string;
  value: string | null;
  onChange: (value: string) => void;
  multiline?: boolean;
  type?: string;
}) {
  const props = {
    value: value ?? "",
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(event.target.value),
  };
  return (
    <label className="flex min-w-0 flex-col gap-1 text-label">
      {label}
      {multiline ? <Textarea {...props} /> : <Input type={type} {...props} />}
    </label>
  );
}
