"use client";

import { useTransition } from "react";
import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { LOCALE_META, LOCALES, intlTag, resolveLocale, type Locale } from "@/i18n/locale";

/**
 * The interface language. With two languages one click switches to the other (the button shows its name); with more,
 * a menu lists every language by its own name. The choice is stored in a cookie per browser.
 */
export function LanguageToggle({ className, locales = LOCALES }: { className?: string; locales?: readonly Locale[] }) {
  const locale = resolveLocale(useLocale());
  const t = useTranslations("shell");
  const [pending, startTransition] = useTransition();
  const choose = (next: string) => startTransition(() => setLocale(next));

  if (locales.length <= 2) {
    const other = locales.find((candidate) => candidate !== locale) ?? locale;
    return (
      <Button variant="ghost" size="sm" className={className} disabled={pending} aria-label={t("toggleLanguageTo", { name: LOCALE_META[other].name })} onClick={() => choose(other)}>
        <Languages aria-hidden />
        <span lang={intlTag(other)}>{LOCALE_META[other].name}</span>
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className={className} disabled={pending} aria-label={t("languageMenuNamed", { name: LOCALE_META[locale].name })} data-testid="language-menu">
          <Languages aria-hidden />
          <span lang={intlTag(locale)}>{LOCALE_META[locale].name}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuLabel>{t("languageMenu")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={locale} onValueChange={choose}>
          {locales.map((id) => (
            <DropdownMenuRadioItem key={id} value={id} lang={intlTag(id)}>
              {LOCALE_META[id].name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
