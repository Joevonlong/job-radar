"use client";

import { useId, useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

type LoginError = "invalid" | "tooMany" | "unavailable" | "network";

const successSchema = z.object({ next: z.string() });
const throttledSchema = z.object({ retry_after: z.number().int().positive() });

/** Where to go after a login: an internal path only (the server already cleaned it; this is the second line). */
function internal(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
}

/**
 * The password form. It posts to `/api/auth/login` and, once the session cookie is set, loads `next` as a full page (so
 * the layout renders for a signed-in visitor). Errors are announced in a live region.
 */
export function LoginForm({ next, insecure = false }: { next: string; insecure?: boolean }) {
  const t = useTranslations("auth");
  const id = useId();
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<{ kind: LoginError; minutes?: number } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ password, next }).toString(),
        credentials: "same-origin",
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok) {
        const parsed = successSchema.safeParse(body);
        window.location.assign(internal(parsed.success ? parsed.data.next : next));
        return;
      }
      setPassword("");
      if (response.status === 429) {
        const parsed = throttledSchema.safeParse(body);
        setError({ kind: "tooMany", minutes: Math.max(1, Math.ceil((parsed.success ? parsed.data.retry_after : 60) / 60)) });
      } else {
        setError({ kind: response.status === 401 ? "invalid" : "unavailable" });
      }
    } catch {
      setError({ kind: "network" });
    }
    setPending(false);
  }

  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-sp-4 py-sp-8" data-testid="login-page">
      {insecure ? (
        <p role="alert" data-testid="login-insecure" className="rounded-tag border-bw border-bad bg-card px-3 py-2 text-body-sm font-bold text-bad">
          {t("insecure")}
        </p>
      ) : null}
      <Card>
        <CardHeader>
          <CardTitle>
            <h1>{t("title")}</h1>
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent className="pt-sp-4">
          <form className="flex flex-col gap-sp-3" onSubmit={(event) => void submit(event)} noValidate>
            <label htmlFor={`${id}-password`} className="text-label font-bold">
              {t("password")}
            </label>
            <Input
              id={`${id}-password`}
              name="password"
              type="password"
              autoComplete="current-password"
              autoFocus
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={error?.kind === "invalid" || undefined}
              aria-describedby={error ? `${id}-error` : undefined}
              data-testid="login-password"
            />
            <p id={`${id}-error`} role="status" aria-live="polite" className="min-h-[1lh] text-body-sm font-bold text-bad" data-testid="login-error">
              {error ? t(`errors.${error.kind}`, { minutes: error.minutes ?? 1 }) : null}
            </p>
            <Button type="submit" disabled={pending || password === ""} data-testid="login-submit">
              {pending ? t("submitting") : t("submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
      <p className="text-body-sm text-ink-2">{t("hint")}</p>
    </div>
  );
}
