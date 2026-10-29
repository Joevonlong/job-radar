"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { previewActivityDeleteAction, executeActivityDeleteAction } from "@/app/sources/logs/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogTrigger, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from "@/components/ui/dialog";
import type { ActivityDeleteInput } from "@/lib/activity/manage";
import { resolveLocale } from "@/i18n/locale";
import { formatInteger } from "@/lib/format/numbers";

type Preview = { input: ActivityDeleteInput; asOf: string; roots: number; events: number; skippedActive: number };

/** The preview freezes scope and timestamp. Continuations use that exact snapshot, independent of list filters. */
export function DeleteDialog({ scope, rootId, today }: { scope: "root" | "range" | "all"; rootId?: string; today: string }) {
  const t = useTranslations("activityLog.delete");
  const locale = resolveLocale(useLocale());
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState(today);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [deleted, setDeleted] = useState({ roots: 0, events: 0 });
  const [partial, setPartial] = useState(false);
  const [nothing, setNothing] = useState(false);
  const [error, setError] = useState<"failed" | "invalid" | "not_ready" | null>(null);
  const [pending, startTransition] = useTransition();
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (preview && !pending) confirm.current?.focus(); }, [preview, partial, pending]);

  function changeOpen(value: boolean) {
    if (pending) return;
    setOpen(value);
    if (!value && nothing) router.refresh();
    if (value) { setPreview(null); setPartial(false); setNothing(false); setError(null); setDeleted({ roots: 0, events: 0 }); setFrom(""); setTo(today); }
  }
  function prepare() {
    startTransition(async () => {
      setError(null);
      const input: ActivityDeleteInput = scope === "root" ? { scope, rootId: rootId! } : scope === "all" ? { scope } : { scope, ...(from ? { from } : {}), to };
      try {
        const result = await previewActivityDeleteAction(input);
        if (result.status === "ok") setPreview({ ...result, input });
        else setError(result.status);
      } catch { setError("failed"); }
    });
  }
  function execute() {
    if (!preview) return;
    startTransition(async () => {
      setError(null);
      try {
        const result = await executeActivityDeleteAction({ ...preview.input, asOf: preview.asOf });
        if (result.status === "done" || result.status === "partial") {
          const total = { roots: deleted.roots + result.roots, events: deleted.events + result.events };
          setDeleted(total);
          if (result.status === "partial") setPartial(true);
          // Everything previewed became active or vanished: say so instead of silently closing.
          else if (!total.roots && !total.events && preview.roots + preview.events > 0) { setPartial(false); setNothing(true); }
          else { setOpen(false); if (scope === "root") router.replace("/sources/logs"); router.refresh(); }
        } else setError(result.status);
      } catch { setError("failed"); }
    });
  }
  const numbers = (counts: { roots: number; events: number }) => ({ roots: formatInteger(counts.roots, locale), events: formatInteger(counts.events, locale) });
  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild><Button variant="outline" size="sm" data-testid={`activity-log-delete-${scope}`}>{t(scope)}</Button></DialogTrigger>
      <DialogContent data-testid="activity-log-delete-dialog" showCloseButton={!pending} onEscapeKeyDown={(event) => { if (pending) event.preventDefault(); }} onInteractOutside={(event) => { if (pending) event.preventDefault(); }}>
        <DialogHeader><DialogTitle>{t(scope)}</DialogTitle><DialogDescription>{t("description")}</DialogDescription></DialogHeader>
        {scope === "range" && !preview ? <div className="grid min-w-0 gap-sp-3 sm:grid-cols-2">
          <label className="min-w-0 text-body-sm">{t("from")}<Input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} disabled={pending} data-testid="activity-log-delete-from" /></label>
          <label className="min-w-0 text-body-sm">{t("to")}<Input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} required disabled={pending} data-testid="activity-log-delete-to" /></label>
        </div> : null}
        <div aria-live="polite" aria-atomic="true" className="grid gap-sp-2 text-body-sm" data-testid="activity-log-delete-preview">
          {preview ? <><p>{t("preview", numbers(preview))}</p><p>{t("skipped", { count: formatInteger(preview.skippedActive, locale) })}</p></> : null}
          {partial ? <p data-testid="activity-log-delete-partial">{t("partial", numbers(deleted))}</p> : null}
          {nothing ? <p data-testid="activity-log-delete-nothing">{t("nothing")}</p> : null}
        </div>
        {error ? <p role="alert">{t(`error.${error}`)}</p> : null}
        <DialogFooter>
          <DialogClose asChild><Button disabled={pending}>{t("cancel")}</Button></DialogClose>
          {nothing ? null : preview ? <Button ref={confirm} variant="destructive" disabled={pending} onClick={execute} data-testid="activity-log-delete-confirm">{pending ? t("working") : partial ? t("continue") : t("confirm")}</Button>
            : <Button disabled={pending || (scope === "range" && (!to || Boolean(from && from > to)))} onClick={prepare} data-testid="activity-log-delete-prepare">{pending ? t("working") : t("prepare")}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
