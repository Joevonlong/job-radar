"use server";

import { cookies } from "next/headers";

import { LOCALE_COOKIE, LOCALE_COOKIE_MAX_AGE, isLocale } from "./locale";

/** Persist the chosen locale in the NEXT_LOCALE cookie. The page re-renders after the action. */
export async function setLocale(locale: string): Promise<void> {
  if (!isLocale(locale)) {
    return;
  }
  const cookieStore = await cookies();
  cookieStore.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
}
