import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

import { defaultUiLocale, languageSettings } from "@/lib/i18n/config";

import { LOCALE_COOKIE, resolveLocale } from "./locale";
import { loadMessages } from "./messages";

/** The language of a request: the cookie when it names an interface language, else `language.yaml: ui.default_locale`. */
export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  // read fresh: the web app has no config watcher, and the file is tiny
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, defaultUiLocale(languageSettings({ fresh: true })));

  return {
    locale,
    messages: await loadMessages(locale),
  };
});
