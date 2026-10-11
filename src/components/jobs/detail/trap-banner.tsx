import { useTranslations } from "next-intl";

/** The line under the title area when the JD holds AI traps; it jumps to the "AI traps" panel. */
export function TrapBanner({ count }: { count: number }) {
  const t = useTranslations("aiTraps");
  return (
    <a
      href="#h-traps"
      className="border-bw border-ink rounded-card bg-bad text-on-bad shadow-e2 flex min-w-0 items-center gap-2 px-4 py-2.5 font-semibold [overflow-wrap:anywhere] underline-offset-4 hover:underline focus-visible:underline"
      data-testid="trap-banner"
      data-count={count}
    >
      <span aria-hidden>🪤</span>
      {t("banner", { count })}
    </a>
  );
}
