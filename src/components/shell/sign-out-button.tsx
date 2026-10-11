import { getTranslations } from "next-intl/server";

/** Signs out of the optional web password: a plain form POST (no script needed); the server clears the cookie. */
export async function SignOutButton({ className }: { className?: string }) {
  const t = await getTranslations("auth");
  return (
    <form method="post" action="/api/auth/logout" className={className}>
      <button type="submit" data-testid="sign-out" className="w-full rounded-btn px-sp-2 py-sp-1 text-left font-mono text-body-sm text-term-dim underline-offset-4 hover:text-term-ink hover:underline focus-visible:text-term-ink">
        {t("signOut")}
      </button>
    </form>
  );
}
