import { getTranslations } from "next-intl/server";

/**
 * Shown on every page while no web password is set and the dashboard is reached from another machine (or listens beyond
 * loopback): anybody who can open this address can read the job search and change the settings. Not dismissable, no
 * script.
 */
export async function AccessBanner() {
  const t = await getTranslations("auth.banner");
  return (
    <div role="alert" data-testid="access-banner" className="border-b-bw border-bad bg-bad px-sp-4 py-sp-2 text-body-sm font-bold text-on-bad">
      <p className="mx-auto max-w-6xl [overflow-wrap:anywhere]">
        {t("text")} <code className="font-mono">pnpm web:password</code> {t("hint")}
      </p>
    </div>
  );
}
