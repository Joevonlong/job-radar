import { getTranslations } from "next-intl/server";

import { MAIN_CONTENT_ID } from "./main-content-id";

/** The first stop of the keyboard order: hidden until it has focus, then jumps past the navigation and top bar to the page. */
export async function SkipLink() {
  const t = await getTranslations("shell");
  return (
    <a
      href={`#${MAIN_CONTENT_ID}`}
      className="sr-only focus:not-sr-only focus:fixed focus:top-sp-2 focus:left-sp-2 focus:z-tooltip focus:border-bw focus:border-border focus:bg-hi focus:px-sp-4 focus:py-sp-2 focus:text-body-sm focus:font-bold focus:text-hi-ink focus:shadow-e2"
    >
      {t("skipToContent")}
    </a>
  );
}
