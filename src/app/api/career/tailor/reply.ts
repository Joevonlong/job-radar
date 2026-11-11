import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { CareerStoreError } from "@/lib/career/contact/errors";
import { ConfigError } from "@/lib/config";
import { readBody } from "@/lib/stories/read-body";

export function reply(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export function refuse(error: string, extra: Record<string, unknown> = {}) {
  const statuses: Record<string, number> = { disabled: 409, busy: 409, review_again: 409, stale: 409, unresolved_claims: 409, job_gone: 404, doc_gone: 404, document_missing: 404, no_jd: 422, invalid: 400, limits: 422, target_gone: 404, unavailable: 503 };
  return reply({ ok: false, error, ...extra }, statuses[error] ?? 422);
}
export function failure(error: unknown) {
  if (error instanceof CareerStoreError) return refuse(error.code);
  if (error instanceof ZodError) return refuse("invalid");
  if (error instanceof ConfigError) return refuse(error.kind === "stale" ? "stale" : "config_error");
  return refuse("unavailable");
}
export async function jsonBody(request: Request, maxBytes: number, timeoutSeconds: number): Promise<unknown> {
  const body = await readBody(request, maxBytes, timeoutSeconds * 1000);
  if (body === null || body === "timeout") throw new CareerStoreError("limits");
  try { return JSON.parse(new TextDecoder().decode(body)); }
  catch { throw new CareerStoreError("document_invalid"); }
}
