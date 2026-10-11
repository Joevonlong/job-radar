import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { Archivo, Archivo_Black, IBM_Plex_Mono, Noto_Sans_SC } from "next/font/google";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { BaseCurrencyProvider } from "@/components/base-currency";
import { AppShell } from "@/components/shell/app-shell";
import { intlTag, resolveLocale } from "@/i18n/locale";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { loadLocalLanguage } from "@/lib/market/view";
import { isLockedOut, readWebAccess, showAccessBanner, showSignOut } from "@/lib/security/web-access";
import { loadBaseCurrency } from "@/lib/signals/floor";

import "./globals.css";

// Design system v3 fonts. globals.css maps --font-display / --font-sans / --font-mono onto these variables.
const archivo = Archivo({
  variable: "--font-archivo",
  subsets: ["latin"],
  weight: ["500", "600", "700", "800"],
  display: "swap",
});
const archivoBlack = Archivo_Black({
  variable: "--font-archivo-black",
  subsets: ["latin"],
  weight: "400",
  display: "swap",
});
const plexMono = IBM_Plex_Mono({
  variable: "--font-plex-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  display: "swap",
});
// CJK fonts are large and split by unicode-range: never preload. No explicit weights: the variable font already covers 900,
// which is the Chinese fallback for display type (Archivo Black has no CJK glyphs).
const notoSansSC = Noto_Sans_SC({
  variable: "--font-noto-sans-sc",
  preload: false,
  display: "swap",
});

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("app");
  return {
    title: { default: t("name"), template: `%s · ${t("name")}` },
    description: t("tagline"),
  };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  const baseCurrency = loadBaseCurrency() ?? "";
  const localLanguage = loadLocalLanguage();
  // The optional web password: the proxy has let this request through; this only decides what the shell shows.
  const webAccess = readWebAccess(await headers(), await cookies());
  const access = { locked: isLockedOut(webAccess), banner: showAccessBanner(webAccess), signOut: showSignOut(webAccess) };

  return (
    <html
      lang={intlTag(resolveLocale(locale))}
      className={`${archivo.variable} ${archivoBlack.variable} ${plexMono.variable} ${notoSansSC.variable}`}
      suppressHydrationWarning
    >
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          themes={["light", "dark"]}
          disableTransitionOnChange
        >
          <NextIntlClientProvider>
            <BaseCurrencyProvider currency={baseCurrency} language={localLanguage}>
              <TooltipProvider>
                <NuqsAdapter>
                  <AppShell access={access}>{children}</AppShell>
                </NuqsAdapter>
                <Toaster />
              </TooltipProvider>
            </BaseCurrencyProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
