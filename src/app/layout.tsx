import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale, getTranslations } from "next-intl/server";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";

import { BaseCurrencyProvider } from "@/components/base-currency";
import { AppShell } from "@/components/shell/app-shell";
import { ActionFeedback } from "@/components/shell/action-feedback";
import { intlTag, resolveLocale } from "@/i18n/locale";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";

import { loadLocalLanguage } from "@/lib/market/view";
import { isLockedOut, readWebAccess, showAccessBanner, showSignOut } from "@/lib/security/web-access";
import { loadBaseCurrency } from "@/lib/signals/floor";

import "./globals.css";

// Design system v3 fonts, self-hosted so that building never needs the network (the files come from the pinned
// Fontsource packages in node_modules; their licences are in licenses/fonts/). globals.css maps --font-display /
// --font-sans / --font-mono onto these variables.
// Each call loads and preloads the latin subset only; globals.css adds the other subsets (latin-ext, vietnamese,
// cyrillic...) as @font-face rules under the same family name, which next/font derives from the constant's name: so the
// constants must keep their names (archivo, archivoBlack, plexMono) and the calls must not set `font-family`.
// The latin unicode-range is Fontsource's, copied verbatim (next/font only accepts literals, hence the repetition).
// The fallback faces (Arial with metric overrides, shown until a web font arrives) are defined in globals.css with the
// metrics Next.js computed for these families, so the layout during a slow load stays as it was; next/font/local
// would derive different ones from the subset files (adjustFontFallback: false turns its own off).
// A variable font limited to 500-800: `font-normal` (400) falls on 500, as it always has.
const archivo = localFont({
  src: "../../node_modules/@fontsource-variable/archivo/files/archivo-latin-wght-normal.woff2",
  weight: "500 800",
  style: "normal",
  variable: "--font-archivo",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["Archivo Fallback"],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});
const archivoBlack = localFont({
  src: "../../node_modules/@fontsource/archivo-black/files/archivo-black-latin-400-normal.woff2",
  weight: "400",
  style: "normal",
  variable: "--font-archivo-black",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["Archivo Black Fallback"],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});
const plexMono = localFont({
  src: [
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../../node_modules/@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
  adjustFontFallback: false,
  fallback: ["IBM Plex Mono Fallback"],
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD",
    },
  ],
});
// Noto Sans SC (CJK, split into many unicode-range files, never preloaded) comes from the Fontsource CSS imported in
// globals.css, which also defines --font-noto-sans-sc.

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
      className={`${archivo.variable} ${archivoBlack.variable} ${plexMono.variable}`}
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
                <ActionFeedback />
              </TooltipProvider>
            </BaseCurrencyProvider>
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
