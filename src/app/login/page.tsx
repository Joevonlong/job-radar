import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { LoginForm } from "@/components/auth/login-form";
import { safeNextPath } from "@/lib/security/auth-gate";
import { isLockedOut, readWebAccess } from "@/lib/security/web-access";

// Reads the environment and the request on every request.
export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("auth");
  return { title: t("title") };
}

/** The login page of the optional web password. Without a password, or already signed in, it goes straight on to `next`. */
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const next = safeNextPath(Array.isArray(raw.next) ? raw.next[0] : raw.next);
  const requestHeaders = await headers();
  const access = readWebAccess(requestHeaders, await cookies());
  if (!isLockedOut(access)) redirect(next);
  // a password sent from another machine over plain http can be read on the way: say so (tailscale serve / a proxy give https)
  const insecure = !access.localRequest && requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase() !== "https";
  return <LoginForm next={next} insecure={insecure} />;
}
