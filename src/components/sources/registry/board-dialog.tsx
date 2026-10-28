"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition } from "react";

import { removeAtsBoardAction as rawRemoveAtsBoardAction, saveAtsBoardAction as rawSaveAtsBoardAction } from "@/app/sources/registry/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ATS_KINDS } from "@/lib/config/schemas/companies";
import type { AtsKind } from "@/lib/sources/registry/entries";
import type { FieldError } from "@/lib/sources/registry/service";
import type { BoardRow } from "@/lib/sources/registry/view";
import { toastTone } from "@/lib/toast";
import { withActionFeedback } from "@/lib/actions/client";

const removeAtsBoardAction = withActionFeedback(rawRemoveAtsBoardAction)(() => ({ status: "error", error: "write_failed" }));
const saveAtsBoardAction = withActionFeedback(rawSaveAtsBoardAction)(() => ({ status: "error", error: "write_failed" }));

type Region = "global" | "eu";

interface Draft {
  name: string;
  ats: AtsKind;
  token: string;
  region: Region;
  enabled: boolean;
}

const EMPTY: Draft = { name: "", ats: "greenhouse", token: "", region: "global", enabled: true };

/** The service's own words for a field problem -> a message key; anything else is shown as it came. */
function fieldKey(message: string): "duplicate" | "regionEu" | "token" | "required" | null {
  if (message === "duplicate ats + token") return "duplicate";
  if (message.startsWith("region eu only")) return "regionEu";
  if (message.startsWith("token must be")) return "token";
  if (message === "must not be empty") return "required";
  return null;
}

/** Add (`board` null) or edit a company board. Errors of the server sit under their field. */
export function BoardDialog({ open, board, onOpenChange }: { open: boolean; board: BoardRow | null; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("sourcesRegistry.board");
  const id = useId();
  const initial: Draft = board ? { name: board.name, ats: board.ats, token: board.token, region: board.region === "eu" ? "eu" : "global", enabled: board.enabled } : EMPTY;
  const [draft, setDraft] = useState<Draft>(initial);
  const [errors, setErrors] = useState<FieldError[]>([]);
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [seen, setSeen] = useState<{ open: boolean; board: BoardRow | null }>({ open, board });
  // each time the dialog opens it starts from the entry being edited (or empty)
  if (seen.open !== open || seen.board !== board) {
    setSeen({ open, board });
    if (open) {
      setDraft(initial);
      setErrors([]);
      setFormError(null);
    }
  }

  /** Edit fields of the draft. The errors of the edited fields go away at once (they described the old value); ats and token together decide "duplicate", ats also decides "region eu". */
  const edit = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    const touched = new Set<string>(Object.keys(patch));
    if (touched.has("ats") || touched.has("token")) for (const key of ["ats", "token", "region"]) touched.add(key);
    setErrors((current) => (current.some((e) => touched.has(e.path)) ? current.filter((e) => !touched.has(e.path)) : current));
    setFormError(null);
  };

  const keyChanged = board !== null && (draft.ats !== board.ats || draft.token.trim() !== board.token);
  const fieldError = (path: string): string | null => {
    const found = errors.find((e) => e.path === path);
    if (!found) return null;
    const key = fieldKey(found.message);
    return key ? t(`errors.${key}`) : found.message;
  };

  const submit = () => {
    setFormError(null);
    startTransition(async () => {
      const result = await saveAtsBoardAction({
        original: board ? { ats: board.ats, token: board.token } : null,
        board: { name: draft.name, ats: draft.ats, token: draft.token, enabled: draft.enabled, ...(draft.ats === "lever" ? { region: draft.region } : {}) },
      });
      if (result.status === "done") {
        toastTone("success", t(result.outcome === "board_added" ? "toast.added" : "toast.updated", { name: draft.name.trim() }));
        onOpenChange(false);
        return;
      }
      setErrors(result.fieldErrors ?? []);
      if (!result.fieldErrors || result.fieldErrors.length === 0) setFormError(t(`formErrors.${result.error}`));
    });
  };

  const field = (path: keyof Draft & string, label: string, control: (props: { id: string; "aria-invalid": boolean; "aria-describedby": string | undefined }) => React.ReactNode) => {
    const message = fieldError(path);
    const fieldId = `${id}-${path}`;
    return (
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-label font-bold">
          {label}
        </label>
        {control({ id: fieldId, "aria-invalid": message !== null, "aria-describedby": message ? `${fieldId}-error` : undefined })}
        {message ? (
          <p id={`${fieldId}-error`} role="alert" className="text-bad text-body-sm font-semibold" data-testid={`board-error-${path}`}>
            {message}
          </p>
        ) : null}
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent data-testid="board-dialog">
        <form
          className="grid gap-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{board ? t("editTitle") : t("addTitle")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {field("name", t("name"), (props) => (
            <Input {...props} value={draft.name} onChange={(event) => edit({ name: event.target.value })} autoComplete="off" data-testid="board-name" />
          ))}
          {field("ats", t("ats"), (props) => (
            <NativeSelect {...props} value={draft.ats} onChange={(event) => edit({ ats: ATS_KINDS.find((k) => k === event.target.value) ?? "greenhouse" })} data-testid="board-ats">
              {ATS_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </NativeSelect>
          ))}
          {field("token", t("token"), (props) => (
            <Input {...props} value={draft.token} onChange={(event) => edit({ token: event.target.value })} autoComplete="off" spellCheck={false} className="font-mono" data-testid="board-token" />
          ))}
          <p className="text-ink-2 -mt-2 text-body-sm">{t("tokenHint")}</p>
          {draft.ats === "lever"
            ? field("region", t("region"), (props) => (
                <NativeSelect {...props} value={draft.region} onChange={(event) => edit({ region: event.target.value === "eu" ? "eu" : "global" })} data-testid="board-region">
                  <option value="global">{t("regionGlobal")}</option>
                  <option value="eu">{t("regionEu")}</option>
                </NativeSelect>
              ))
            : null}
          <div className="flex items-center gap-3">
            <Switch checked={draft.enabled} onCheckedChange={(enabled) => edit({ enabled })} id={`${id}-enabled`} aria-label={t("enabled")} data-testid="board-enabled" />
            <label htmlFor={`${id}-enabled`} className="text-label font-bold">
              {t("enabled")}
            </label>
          </div>
          {keyChanged ? (
            <p className="text-body-sm font-semibold" role="status" data-testid="board-key-changed">
              {t("keyChanged")}
            </p>
          ) : null}
          {formError ? (
            <p role="alert" className="text-bad text-body-sm font-semibold" data-testid="board-form-error">
              {formError}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="default" onClick={() => onOpenChange(false)} disabled={pending}>
              {t("cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={pending} aria-busy={pending} data-testid="board-save">
              {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
              {pending ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Delete Wolt from sources.yaml?": an irreversible edit of the file, so it asks first. */
export function DeleteBoardDialog({ board, onOpenChange }: { board: BoardRow | null; onOpenChange: (open: boolean) => void }) {
  const t = useTranslations("sourcesRegistry.board");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const confirm = () => {
    if (!board) return;
    setError(null);
    startTransition(async () => {
      const result = await removeAtsBoardAction({ ats: board.ats, token: board.token });
      if (result.status === "done") {
        toastTone("success", t("toast.removed", { name: board.name }));
        onOpenChange(false);
      } else {
        setError(t(`formErrors.${result.error}`));
      }
    });
  };
  return (
    <Dialog open={board !== null} onOpenChange={(next) => (pending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-[420px]" data-testid="board-delete-dialog">
        <DialogHeader>
          <DialogTitle>{t("deleteTitle")}</DialogTitle>
          <DialogDescription>{board ? t("deleteBody", { name: board.name }) : ""}</DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-bad text-body-sm font-semibold">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="default" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("cancel")}
          </Button>
          <Button type="button" variant="danger" onClick={confirm} disabled={pending} aria-busy={pending} data-testid="board-delete-confirm">
            {pending ? <Loader2 aria-hidden className="animate-spin" /> : null}
            {t("delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
