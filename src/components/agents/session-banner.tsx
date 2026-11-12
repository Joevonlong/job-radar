"use client";

import { AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useState, type FormEvent } from "react";

import { postLogin, type LoginError } from "@/components/auth/post-login";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Shown when a web password is set and this request has no session (a local request skips the login for the rest of the dashboard).
 * The password goes to the same login endpoint as the login page; with the session cookie set, the page reloads at `next`.
 */
export function SessionBanner({ next }: { next: string }) {
  const t = useTranslations("agents.session");
  const tAuth = useTranslations("auth");
  const id = useId();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ kind: LoginError; minutes?: number } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    const result = await postLogin(password, next);
    if (result.ok) {
      window.location.assign(result.next);
      return;
    }
    if (result.error !== "network") setPassword("");
    setError({ kind: result.error, ...(result.minutes === undefined ? {} : { minutes: result.minutes }) });
    setPending(false);
  }

  return (
    <section aria-labelledby={`${id}-title`} data-testid="agents-session-banner" className="flex items-stretch overflow-hidden rounded-card border-bw border-border bg-warn text-on-signal shadow-e2">
      <span aria-hidden className="jr-hatch w-3 flex-none border-r-bw border-border text-ink" />
      <div className="flex min-w-0 flex-1 flex-col gap-sp-2 px-4 py-3">
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-body font-bold">
          <AlertTriangle aria-hidden className="size-4 flex-none" />
          {t("title")}
        </h2>
        <p className="text-body-sm font-semibold [overflow-wrap:anywhere]">{t("body")}</p>
        <form className="flex flex-wrap items-end gap-sp-2" onSubmit={(event) => void submit(event)} noValidate>
          <div className="flex min-w-0 flex-1 basis-56 flex-col gap-1">
            <label htmlFor={`${id}-password`} className="text-label font-bold">
              {t("password")}
            </label>
            <Input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error?.kind === "invalid" || undefined}
              aria-describedby={`${id}-error`}
              data-testid="agents-login-password"
            />
          </div>
          <Button type="submit" variant="ink" disabled={pending || password === ""} data-testid="agents-login-submit">
            {pending ? t("submitting") : t("submit")}
          </Button>
        </form>
        <p id={`${id}-error`} role="status" aria-live="polite" className="min-h-[1lh] text-body-sm font-bold" data-testid="agents-login-error">
          {error ? tAuth(`errors.${error.kind}`, { minutes: error.minutes ?? 1 }) : null}
        </p>
      </div>
    </section>
  );
}
