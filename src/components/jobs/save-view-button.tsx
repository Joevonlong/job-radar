"use client";

import { Bookmark } from "lucide-react";
import { useTranslations } from "next-intl";
import { useQueryStates } from "nuqs";
import { useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { saveViewAction as rawSaveViewAction } from "@/app/interests/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { InterestsFormError } from "@/lib/interests/types";
import { hasViewFilters, viewFiltersFromParams } from "@/lib/interests/view-filters";
import { withLegacyKeys } from "@/lib/jobs/search-params";
import { resolveJobScope } from "@/lib/jobs/scope";
import { jobsSearchParsers } from "@/lib/jobs/search-params";
import { withActionFeedback } from "@/lib/actions/client";

const saveViewAction = withActionFeedback(rawSaveViewAction)(() => ({ status: "error", section: "views", nonce: Date.now(), formError: "writeFailed", fieldErrors: [] }));

const MAX_NAME_CHARS = 60;

/** "Save the current filters as a view" on /jobs: names the filters now in the URL and stores them in interests.yaml. */
export function SaveViewButton() {
  const t = useTranslations("interests.saveView");
  const tSearch = useTranslations("dashboard.jobs.filters");
  const tScope = useTranslations("dashboard.jobs.scope");
  const tErrors = useTranslations("interests.formErrors");
  const [params] = useQueryStates(jobsSearchParsers);
  const filters = viewFiltersFromParams(withLegacyKeys(params));
  const canSave = hasViewFilters(filters);
  const excludedSearch = params.country.length > 0 || params.searchIn === "all";
  // why nothing can be saved when the only filters are ones a view cannot hold
  const disabledHint = excludedSearch ? tSearch("notSaved") : null;
  const searchHintId = useId();
  const tFav = useTranslations("favorites");

  const nameId = useId();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [error, setError] = useState<InterestsFormError | null>(null);
  const [pending, startTransition] = useTransition();

  function submit(overwrite: boolean) {
    startTransition(async () => {
      const result = await saveViewAction({ name, filters, overwrite, makeDefault });
      if (result.status === "saved") {
        toast.success(t("savedToast", { name: name.trim() }));
        setOpen(false);
        setName("");
        setMakeDefault(false);
        setError(null);
      } else if (result.status === "error") {
        setError(result.formError ?? "invalidPayload");
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={!canSave} title={canSave ? undefined : (disabledHint ?? t("needFilters"))} aria-describedby={!canSave && disabledHint ? searchHintId : undefined} data-testid="save-view">
          <Bookmark aria-hidden /> {t("button")}
        </Button>
      </DialogTrigger>
      {!canSave && disabledHint ? <span id={searchHintId} className="sr-only">{disabledHint}</span> : null}
      <DialogContent>
        <form
          noValidate
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit(false);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          {resolveJobScope(params.scope, params.status) !== "current" ? (
            <p className="text-ink-2 text-body-sm" data-testid="save-view-scope-hint">{tScope("notSaved")}</p>
          ) : null}
          {excludedSearch ? <p className="text-ink-2 text-body-sm" data-testid="save-view-search-hint">{tSearch("notSaved")}</p> : null}
          <div className="flex flex-col gap-1.5">
            <label htmlFor={nameId} className="text-sm font-medium">
              {t("name")}
            </label>
            <Input
              id={nameId}
              value={name}
              maxLength={MAX_NAME_CHARS}
              placeholder={t("namePlaceholder")}
              autoComplete="off"
              aria-invalid={error === "invalidName" || error === "nameTaken" || undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
              data-testid="save-view-name"
            />
          </div>
          {params.fav === true ? (
            <p className="text-ink-2 text-sm" data-testid="save-view-fav-hint">
              {tFav("saveViewHint")}
            </p>
          ) : null}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary size-4" checked={makeDefault} onChange={(event) => setMakeDefault(event.target.checked)} data-testid="save-view-default" />
            {t("makeDefault")}
          </label>
          {error ? (
            <p role="alert" className="text-destructive text-sm" data-testid="save-view-error">
              {tErrors(error)}
            </p>
          ) : null}
          <DialogFooter>
            {error === "nameTaken" ? (
              <Button type="button" variant="outline" disabled={pending} onClick={() => submit(true)} data-testid="save-view-overwrite">
                {t("overwrite")}
              </Button>
            ) : null}
            <Button type="submit" disabled={pending || name.trim() === ""} data-testid="save-view-submit">
              {pending ? t("saving") : t("save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
