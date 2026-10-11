import { useLocale } from "next-intl";

import { FALLBACK, isLocale, type Locale } from "@/i18n/locale";

/** The app locale for the format functions (works in server and client components; falls back to English). */
export function useAppLocale(override?: Locale): Locale {
  const current = useLocale();
  if (override) return override;
  return isLocale(current) ? current : FALLBACK;
}
