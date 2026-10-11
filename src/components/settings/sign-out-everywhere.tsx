import { getTranslations } from "next-intl/server";

import { Button } from "@/components/ui/button";
import { LOGOUT_ALL_API_PATH } from "@/lib/security/auth-gate";

/**
 * "Sign out everywhere" for the optional web password: a plain form POST (no script needed). The server raises the
 * session generation, so every browser that signed in with the password (this one too) has to sign in again.
 */
export async function SignOutEverywhere() {
  const t = await getTranslations("auth.everywhere");
  return (
    <section className="flex flex-col gap-2 rounded-card border-bw border-border bg-card px-4 py-3" data-testid="sessions-card" aria-labelledby="sessions-card-title">
      <h2 id="sessions-card-title" className="font-display text-h2">
        {t("title")}
      </h2>
      <p className="text-body text-ink-2">{t("hint")}</p>
      <form method="post" action={LOGOUT_ALL_API_PATH}>
        <Button type="submit" size="sm" data-testid="sign-out-everywhere">
          {t("button")}
        </Button>
      </form>
    </section>
  );
}
