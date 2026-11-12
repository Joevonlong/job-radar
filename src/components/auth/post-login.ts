import { z } from "zod";

export type LoginError = "invalid" | "tooMany" | "unavailable" | "network";
export type LoginResult = { ok: true; next: string } | { ok: false; error: LoginError; minutes?: number };

const successSchema = z.object({ next: z.string() });
const throttledSchema = z.object({ retry_after: z.number().int().positive() });

/** Where to go after a login: an internal path only (the server already cleaned it; this is the second line). */
export function internalPath(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
}

/** Posts the web password to `/api/auth/login`; on success the session cookie is set and `next` is where to go. */
export async function postLogin(password: string, next: string): Promise<LoginResult> {
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password, next }).toString(),
      credentials: "same-origin",
    });
    const body: unknown = await response.json().catch(() => null);
    if (response.ok) {
      const parsed = successSchema.safeParse(body);
      return { ok: true, next: internalPath(parsed.success ? parsed.data.next : next) };
    }
    if (response.status === 429) {
      const parsed = throttledSchema.safeParse(body);
      return { ok: false, error: "tooMany", minutes: Math.max(1, Math.ceil((parsed.success ? parsed.data.retry_after : 60) / 60)) };
    }
    return { ok: false, error: response.status === 401 ? "invalid" : "unavailable" };
  } catch {
    return { ok: false, error: "network" };
  }
}
