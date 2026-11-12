"use client";

import { AlertTriangle, Copy } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";

import { createAgentTokenAction } from "@/app/settings/agents/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Segmented, SegmentedItem } from "@/components/ui/segmented";
import { PERMISSION_NOTES, PRESET_IDS, normalizePermissions, presetOf, presetSelection, type PresetId } from "@/lib/agent-access/matrix";
import type { Permission } from "@/lib/agent-access/permissions";
import type { CreateAgentTokenFailure } from "@/lib/agent-access/token-service";
import { toastTone } from "@/lib/toast";

import { SHEET_ON_PHONE } from "./stdio-dialog";

/** Kept in step with the shared name rule in src/lib/agent-access/tokens.ts; the server checks it again. */
const NAME_MAX = 64;

/** The day after `day` (YYYY-MM-DD): the earliest expiry the form offers. */
function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

interface CreateFormProps {
  matrix: Permission[];
  today: string;
  onCreated: (created: { secret: string; name: string }) => void;
}

function CreateForm({ matrix, today, onCreated }: CreateFormProps) {
  const t = useTranslations("agents.tokens.dialog");
  const tNotes = useTranslations("agents.matrix.notes");
  const tPresets = useTranslations("agents.matrix.presets");
  const id = useId();
  const [name, setName] = useState("");
  const [selection, setSelection] = useState<Permission[]>(() => presetSelection("read_only", matrix));
  const [expiry, setExpiry] = useState<"never" | "date">("never");
  const [day, setDay] = useState("");
  const [error, setError] = useState<CreateAgentTokenFailure | null>(null);
  const [pending, startTransition] = useTransition();
  const chosen = new Set(selection);
  const minDay = nextDay(today);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (expiry === "date" && (day === "" || day < minDay)) {
      setError("expires_past");
      return;
    }
    setError(null);
    startTransition(async () => {
      try {
        const result = await createAgentTokenAction({ name, permissions: selection, expires: expiry === "date" ? day : null });
        if (result.status === "created") onCreated({ secret: result.secret, name: result.token.name });
        else setError(result.status);
      } catch {
        setError("failed");
      }
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-4" data-testid="token-create-form">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-name`} className="text-body-sm font-bold">
          {t("name")}
        </label>
        <Input
          id={`${id}-name`}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={NAME_MAX}
          required
          autoComplete="off"
          disabled={pending}
          aria-invalid={error === "name_invalid" || error === "name_taken"}
          aria-describedby={`${id}-name-hint`}
          data-testid="token-name-input"
        />
        <p id={`${id}-name-hint`} className="text-label text-ink-3">
          {t("nameHint", { max: NAME_MAX })}
        </p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-body-sm font-bold">{t("permissions")}</legend>
        {matrix.length === 0 ? (
          <p className="text-body-sm text-ink-2" data-testid="token-matrix-empty">
            {t("matrixEmpty")}
          </p>
        ) : (
          <>
            <Segmented aria-label={t("presetsLabel")} value={presetOf(selection, matrix) ?? ""} onValueChange={(value) => setSelection(presetSelection(value as PresetId, matrix))} disabled={pending}>
              {PRESET_IDS.map((preset) => (
                <SegmentedItem key={preset} value={preset}>
                  {tPresets(preset)}
                </SegmentedItem>
              ))}
            </Segmented>
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2" data-testid="token-permissions">
              {matrix.map((permission) => {
                const note = PERMISSION_NOTES[permission];
                return (
                  <label key={permission} className="flex min-h-11 cursor-pointer items-start gap-2 py-1.5">
                    <Checkbox
                      checked={chosen.has(permission)}
                      disabled={pending}
                      onCheckedChange={(value) => setSelection((current) => normalizePermissions(value === true ? [...current, permission] : current.filter((item) => item !== permission)))}
                      data-testid={`token-permission-${permission}`}
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
            </div>
          </>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-body-sm font-bold">{t("expires")}</legend>
        <RadioGroup value={expiry} onValueChange={(value) => setExpiry(value === "date" ? "date" : "never")} disabled={pending} aria-label={t("expires")}>
          <label className="flex min-h-11 cursor-pointer items-center gap-2">
            <RadioGroupItem value="never" data-testid="token-expiry-never" />
            <span className="text-body-sm">{t("expiresNever")}</span>
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex min-h-11 cursor-pointer items-center gap-2">
              <RadioGroupItem value="date" data-testid="token-expiry-date" />
              <span className="text-body-sm">{t("expiresOn")}</span>
            </label>
            <Input
              type="date"
              value={day}
              min={minDay}
              onChange={(event) => {
                setDay(event.target.value);
                setExpiry("date");
              }}
              disabled={pending}
              aria-label={t("expiresDay")}
              aria-invalid={error === "expires_past" || error === "expires_invalid"}
              className="w-44"
              data-testid="token-expiry-day"
            />
          </div>
        </RadioGroup>
      </fieldset>
      {error === null ? null : (
        <p role="alert" className="text-body-sm font-bold text-bad" data-testid="token-create-error" data-error={error}>
          {t(`errors.${error}`, { max: NAME_MAX })}
        </p>
      )}
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button">{t("cancel")}</Button>
        </DialogClose>
        <Button type="submit" variant="primary" disabled={pending || selection.length === 0 || name.trim() === ""} data-testid="token-create-submit">
          {pending ? t("creating") : t("submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * The new token, shown this once. It lives only in this component's state: closing the dialog unmounts it, and nothing writes it to
 * the URL, a toast, browser storage or the page's data. When the clipboard is not available the text is selected for copying by hand.
 */
function SecretView({ secret, address }: { secret: string; address: string }) {
  const t = useTranslations("agents.tokens.secret");
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  async function copy() {
    try {
      await navigator.clipboard.writeText(secret);
      toastTone("success", t("copied"));
    } catch {
      ref.current?.focus();
      ref.current?.select();
      toastTone("info", t("copyFailed"));
    }
  }
  return (
    <div className="flex flex-col gap-4" data-testid="token-secret-view">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-secret`} className="text-body-sm font-bold">
          {t("label")}
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            ref={ref}
            id={`${id}-secret`}
            readOnly
            value={secret}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 font-mono text-data"
            spellCheck={false}
            autoComplete="off"
            data-testid="token-secret"
          />
          <Button type="button" variant="primary" onClick={() => void copy()} data-testid="token-copy">
            <Copy aria-hidden />
            {t("copy")}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-body-sm font-bold">{t("address")}</span>
        <code className="rounded-tag border-bw border-border bg-soft px-2 py-1 font-mono text-data [overflow-wrap:anywhere]" data-testid="token-address">
          {address}
        </code>
        <span className="text-body-sm font-bold">{t("example")}</span>
        <code className="rounded-tag border-bw border-border bg-soft px-2 py-1 font-mono text-data [overflow-wrap:anywhere]" data-testid="token-example">
          {`claude mcp add --transport http job-radar ${address} --header "Authorization: Bearer TOKEN"`}
        </code>
      </div>
      <p className="flex items-start gap-2 rounded-cell border-bw border-border bg-warn px-3 py-2 text-body-sm font-bold text-on-signal" role="note">
        <AlertTriangle aria-hidden className="mt-0.5 size-4 flex-none" />
        {t("warning")}
      </p>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="primary" data-testid="token-secret-done">
            {t("done")}
          </Button>
        </DialogClose>
      </DialogFooter>
    </div>
  );
}

interface TokenCreateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Only what the global matrix allows can be granted. */
  matrix: Permission[];
  address: string;
  today: string;
}

/** Name, permissions and expiry; after the server created the token the same dialog shows it once. */
export function TokenCreateDialog({ open, onOpenChange, matrix, address, today }: TokenCreateDialogProps) {
  const t = useTranslations("agents.tokens");
  const [created, setCreated] = useState<{ secret: string; name: string } | null>(null);
  // Forget the secret as soon as the dialog closes (adjusting state during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setCreated(null);
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={SHEET_ON_PHONE}
        data-testid="token-create-dialog"
        // While the token is shown, only the buttons close the dialog: a stray click outside would lose it.
        onInteractOutside={(event) => {
          if (created !== null) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>{created === null ? t("dialog.title") : t("secret.title", { name: created.name })}</DialogTitle>
          <DialogDescription>{created === null ? t("dialog.description") : t("secret.description")}</DialogDescription>
        </DialogHeader>
        {created === null ? <CreateForm matrix={matrix} today={today} onCreated={setCreated} /> : <SecretView secret={created.secret} address={address} />}
      </DialogContent>
    </Dialog>
  );
}
