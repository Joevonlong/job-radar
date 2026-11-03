"use client";

import { Check, Loader2, Pencil, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useId, useState, useTransition, type FormEvent } from "react";

import { confirmCompanyDomainAction as rawConfirm, saveCompanyDomainAction as rawSave, type CompanyDomainActionResult } from "@/app/jobs/[id]/research-actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { withActionFeedback } from "@/lib/actions/client";
import type { CompanyWebsite } from "@/lib/research/domain";
import { toastTone } from "@/lib/toast";

const confirmAction = withActionFeedback(rawConfirm)(() => ({ ok: false, error: "failed" }));
const saveAction = withActionFeedback(rawSave)(() => ({ ok: false, error: "failed" }));

/**
 * The company's website: an inferred one to confirm or change, a confirmed one to change, or none to add. Plain text; the
 * server checks what is saved. Shared by the job page and the company list.
 */
export function CompanyDomainRow({ companyId, website }: { companyId: number; website: CompanyWebsite | null }) {
  const t = useTranslations("research.domain");
  const router = useRouter();
  const inputId = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(website?.domain ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const finish = (result: CompanyDomainActionResult): void => {
    if (!result.ok) {
      setError(t(result.error));
      return;
    }
    setError(null);
    setEditing(false);
    setValue(result.domain);
    toastTone("success", t("saved"));
    router.refresh();
  };
  const confirm = (domain: string): void => {
    setError(null);
    startTransition(async () => finish(await confirmAction({ companyId, domain })));
  };
  const save = (event: FormEvent): void => {
    event.preventDefault();
    setError(null);
    startTransition(async () => finish(await saveAction({ companyId, domain: value })));
  };

  const errorLine = error ? (
    <p role="alert" className="text-bad text-body-sm w-full" data-testid="company-domain-error">
      {error}
    </p>
  ) : null;

  if (editing) {
    return (
      <form onSubmit={save} className="flex flex-wrap items-center gap-2" data-testid="company-domain-form">
        <label htmlFor={inputId} className="text-ink-2 text-body-sm">
          {t("label")}
        </label>
        <Input id={inputId} value={value} onChange={(event) => setValue(event.target.value)} placeholder={t("placeholder")} autoComplete="off" spellCheck={false} className="w-full max-w-64 font-mono" autoFocus data-testid="company-domain-input" />
        <Button type="submit" variant="primary" size="sm" disabled={pending || value.trim() === ""} aria-busy={pending} data-testid="company-domain-save">
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
          {t("save")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setEditing(false);
            setError(null);
            setValue(website?.domain ?? "");
          }}
          data-testid="company-domain-cancel"
        >
          {t("cancel")}
        </Button>
        {errorLine}
      </form>
    );
  }

  const changeButton = (
    <Button type="button" variant="outline" size="sm" disabled={pending} onClick={() => setEditing(true)} data-testid="company-domain-change">
      <Pencil aria-hidden />
      {t("change")}
    </Button>
  );

  if (website === null) {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="company-domain" data-state="none">
        <p className="text-ink-2 text-body-sm">{t("none")}</p>
        <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} data-testid="company-domain-add">
          <Plus aria-hidden />
          {t("add")}
        </Button>
      </div>
    );
  }

  if (website.source === "user") {
    return (
      <div className="flex flex-wrap items-center gap-2" data-testid="company-domain" data-state="confirmed">
        <p className="text-ink-2 text-body-sm [overflow-wrap:anywhere]">{t("confirmed", { domain: website.domain })}</p>
        {changeButton}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5" data-testid="company-domain" data-state="inferred">
      <p className="text-ink-2 text-body-sm [overflow-wrap:anywhere]">{t("inferred", { domain: website.domain })}</p>
      <p className="text-ink-3 text-body-sm">{t("inferredHint")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={pending} aria-busy={pending} onClick={() => confirm(website.domain)} data-testid="company-domain-confirm">
          {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Check aria-hidden />}
          {t("confirm")}
        </Button>
        {changeButton}
      </div>
      {errorLine}
    </div>
  );
}
